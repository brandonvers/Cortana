import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { AppError } from '@cortana/core';
import { recordingLogger } from '@cortana/core/testing';
import { instances, openStorage } from '@cortana/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT } from './exit.ts';
import { announceSecretProtection, reportStartupFailure, runDaemon } from './main.ts';

const BIN = join(import.meta.dirname, 'bin.ts');

let root: string;
let running: ChildProcess | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-daemon-'));
  running = null;
});

afterEach(() => {
  if (running && running.exitCode === null) running.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

interface Started {
  readonly child: ChildProcess;
  readonly output: () => string;
  waitFor(fragment: string, timeoutMs?: number): Promise<void>;
  exit(): Promise<number>;
}

/**
 * Spawns the real executable. A daemon that is mocked is not a daemon: what is
 * being tested here is signal handling, exit codes, and whether the process
 * stays alive at all, none of which survive being stood in for.
 */
function start(env: Record<string, string> = {}): Started {
  const child = spawn(process.execPath, [BIN], {
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: join(root, 'home'),
      XDG_CONFIG_HOME: join(root, 'no-config'),
      CORTANA_DATA_DIR: join(root, 'state'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running = child;

  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });

  return {
    child,
    output: () => output,
    async waitFor(fragment, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!output.includes(fragment)) {
        if (Date.now() > deadline) {
          throw new Error(`waited ${timeoutMs}ms for "${fragment}". Output so far:\n${output}`);
        }
        // signalCode as well as exitCode: a process killed by a signal has a
        // null exit code, so checking only that turns "it was killed" into a
        // five-second timeout with nothing in it to read. That is exactly how
        // this suite reported a real defect on CI, and it cost a round trip.
        if (child.exitCode !== null || child.signalCode !== null) {
          const how = child.signalCode ?? `exit ${child.exitCode}`;
          throw new Error(`the daemon died (${how}) before "${fragment}" appeared:\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    exit() {
      return new Promise<number>((resolve) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        child.on('exit', (code) => resolve(code ?? -1));
      });
    },
  };
}

function instanceRows() {
  const storage = openStorage({ dataDir: join(root, 'state') });
  try {
    return storage.db.select().from(instances).all();
  } finally {
    storage.close();
  }
}

describe('starting', () => {
  it('comes up on a machine with no configuration at all', async () => {
    const daemon = start();

    await daemon.waitFor('kernel started');

    const entries = daemon
      .output()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.some((e) => e['msg'] === 'configuration loaded')).toBe(true);
    expect(entries.every((e) => typeof e['level'] === 'number')).toBe(true);

    daemon.child.kill('SIGTERM');
    expect(await daemon.exit()).toBe(EXIT.OK);
  });

  it('stays running instead of exiting once there is nothing left to do', async () => {
    // The regression this test exists for: a signal listener is not something
    // libuv counts as a reason to stay alive, so the daemon started, recorded
    // the run, announced itself, and then exited 13 with "unsettled top-level
    // await" — looking like a crash rather than a missing handle.
    const daemon = start();
    await daemon.waitFor('kernel started');

    await new Promise((resolve) => setTimeout(resolve, 750));

    expect(daemon.child.exitCode).toBeNull();
    daemon.child.kill('SIGTERM');
    await daemon.exit();
  });
});

describe('stopping', () => {
  it('drains and exits cleanly on SIGTERM', async () => {
    const daemon = start();
    await daemon.waitFor('kernel started');

    daemon.child.kill('SIGTERM');

    expect(await daemon.exit()).toBe(EXIT.OK);
    expect(daemon.output()).toContain('stopped cleanly');
    expect(instanceRows()[0]?.stoppedAt).toBeGreaterThan(0);
  });

  it('treats SIGINT the same way', async () => {
    const daemon = start();
    await daemon.waitFor('kernel started');

    daemon.child.kill('SIGINT');

    expect(await daemon.exit()).toBe(EXIT.OK);
    expect(instanceRows()[0]?.stoppedAt).toBeGreaterThan(0);
  });

  it('answers SIGHUP honestly instead of dying', async () => {
    // SIGHUP's default disposition also ends the process, and it conventionally
    // means "reload". There is no reload yet, so the daemon says so rather than
    // vanishing on an operator who expected one.
    const daemon = start();
    await daemon.waitFor('kernel started');

    daemon.child.kill('SIGHUP');
    await new Promise((resolve) => setTimeout(resolve, 250));

    // The claim is that it survived, which is checked directly rather than by
    // waiting for a log line to arrive — the line is asserted below, after a
    // clean stop, so the test does not depend on when a lone write is flushed.
    expect(daemon.child.exitCode).toBeNull();
    expect(daemon.child.signalCode).toBeNull();

    daemon.child.kill('SIGTERM');
    expect(await daemon.exit()).toBe(EXIT.OK);
    expect(daemon.output()).toContain('reloading configuration is not implemented');
  });
});

describe('a signal that arrives before the daemon can hear it', () => {
  it('is honoured rather than lost', async () => {
    // bin.ts installs placeholder handlers before importing anything heavy,
    // because loading this daemon's module graph was measured at 325ms and
    // until a handler exists a signal ends the process outright. What arrived
    // in that window is handed over here.
    //
    // Driven directly rather than by timing a spawn: the handover is what needs
    // proving, and a test that races the module loader would be measuring the
    // machine it runs on.
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });

    const code = await runDaemon({
      env: {
        HOME: join(root, 'home'),
        XDG_CONFIG_HOME: join(root, 'no-config'),
        CORTANA_DATA_DIR: join(root, 'state'),
      },
      early: { arrived: ['SIGTERM'], release: () => undefined },
      signalSource: new EventEmitter(),
      destination: sink,
    });

    expect(code).toBe(EXIT.OK);
    expect(lines.join('')).toContain('stop requested before the daemon had finished starting');
    expect(lines.join('')).toContain('stopped cleanly');
  });

  it('answers a hangup from that window without stopping', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const emitter = new EventEmitter();

    const run = runDaemon({
      env: {
        HOME: join(root, 'home'),
        XDG_CONFIG_HOME: join(root, 'no-config'),
        CORTANA_DATA_DIR: join(root, 'state'),
      },
      early: { arrived: ['SIGHUP'], release: () => undefined },
      signalSource: emitter,
      destination: sink,
    });

    // It must still be waiting: a hangup is not a stop.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(lines.join('')).toContain('reloading configuration is not implemented');
    emitter.emit('SIGTERM');

    expect(await run).toBe(EXIT.OK);
  });
});

describe('when the operator has made a mistake', () => {
  it('names the setting and does not print a stack trace', async () => {
    // The definition of done, verbatim: "exits naming the setting that is
    // missing — never a stack trace". Frames from this codebase describe this
    // codebase, and the reader's problem is a line in their own file.
    const daemon = start({ CORTANA_LOG_LEVEL: 'chatty' });

    const code = await daemon.exit();

    expect(code).toBe(EXIT.CONFIGURATION);
    expect(daemon.output()).toContain('log.level');
    expect(daemon.output()).toContain('CORTANA_LOG_LEVEL');
    expect(daemon.output()).not.toContain('at ');
    expect(daemon.output()).not.toContain('.ts:');
  });

  it('reports every problem at once rather than one restart at a time', async () => {
    const daemon = start({ CORTANA_LOG_LEVEL: 'chatty', CORTANA_SHUTDOWN_TIMEOUT_MS: 'soon' });

    expect(await daemon.exit()).toBe(EXIT.CONFIGURATION);
    expect(daemon.output()).toContain('2 problem(s)');
  });

  it('separates a start failure from a configuration failure', async () => {
    // A different code because a different person has to act: configuration is
    // the operator's to fix and restarting will not help, while a start failure
    // may be transient.
    // A file where the data directory should be. Self-contained rather than
    // pointing at a system path, which differs between the two supported
    // platforms and would make the test about the platform.
    const occupied = join(root, 'occupied');
    writeFileSync(occupied, 'not a directory');
    const daemon = start({ CORTANA_DATA_DIR: occupied });

    expect(await daemon.exit()).toBe(EXIT.START_FAILED);
    expect(daemon.output()).toContain(occupied);
  });
});

describe('a component that failed to start', () => {
  const written = () => {
    let text = '';
    const destination = new Writable({
      write(chunk, _encoding, done) {
        text += String(chunk);
        done();
      },
    });
    return { destination, text: () => text };
  };
  const failedBecause = (cause: unknown) =>
    new AppError('the component "telegram" failed to start', {
      category: 'internal',
      code: 'component-start-failed',
      detail: { component: 'telegram' },
      cause,
    });

  it('exits as a configuration error when configuration is why, so it is not restarted', () => {
    // The unit restarts on failure except for this code. A missing credential
    // reported as a start failure was restarted every five seconds, forever,
    // for something only the operator can fix.
    const out = written();
    const code = reportStartupFailure(
      failedBecause(
        new AppError('the credential "telegram-bot-token" cannot be read: it is missing', {
          category: 'config',
          code: 'credential-missing',
        }),
      ),
      out.destination,
    );

    expect(code).toBe(EXIT.CONFIGURATION);
    expect(out.text()).toContain('telegram-bot-token');
  });

  it('stays a start failure when the cause is anything else, which may be transient', () => {
    const out = written();
    const code = reportStartupFailure(
      failedBecause(new AppError('disk full', { category: 'storage', code: 'disk-full' })),
      out.destination,
    );

    expect(code).toBe(EXIT.START_FAILED);
  });
});

describe('announcing what a credential here would be worth', () => {
  const machine = (platform: NodeJS.Platform, present: readonly string[]) => ({
    platform,
    exists: (path: string) => present.includes(path),
    env: {},
  });

  it('warns, and only warns, when nothing would be encrypted', () => {
    // "Announced" is not the same as "alarming". A development machine on the
    // Keychain and a server on a host key are both working as designed, and a
    // line that cries wolf every boot is a line people stop reading. Rung 4 is
    // different: there is no encryption there at all.
    const log = recordingLogger();
    announceSecretProtection(log, machine('linux', []));

    expect(log.entries[0]?.level).toBe('warn');
    expect(log.entries[0]?.message).toMatch(/would not be encrypted/);
  });

  it.each([
    [
      'sealed to a TPM',
      machine('linux', ['/run/systemd/system', '/usr/bin/systemd-creds', '/sys/class/tpm/tpm0']),
    ],
    ['a host key', machine('linux', ['/run/systemd/system', '/usr/bin/systemd-creds'])],
    ['the Keychain', machine('darwin', ['/usr/bin/security'])],
  ])('announces %s without alarm', (_name, probes) => {
    const log = recordingLogger();
    announceSecretProtection(log, probes);

    expect(log.entries[0]?.level).toBe('info');
    expect(log.entries[0]?.fields['sealed']).toBeDefined();
    expect(log.entries[0]?.fields['keyLocation']).toBeTruthy();
  });

  it('says so at boot, in the real process', async () => {
    const daemon = start();
    await daemon.waitFor('kernel started');

    expect(daemon.output()).toMatch(/credential protection|would not be encrypted/);

    daemon.child.kill('SIGTERM');
    await daemon.exit();
  });
});
