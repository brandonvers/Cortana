import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { AppError } from '@cortana/core';
import { recordingLogger } from '@cortana/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, runCli } from './cli.ts';
import { type Channel, createChannel, type SayHandler } from './server.ts';

let root: string;
let dataDir: string;
let channel: Channel | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-cli-'));
  dataDir = join(root, 'state');
  channel = null;
});

afterEach(async () => {
  await channel?.stop();
  // A test below takes every permission away from the data directory.
  chmodSync(root, 0o700);
  try {
    chmodSync(dataDir, 0o700);
  } catch {
    // Never created.
  }
  rmSync(root, { recursive: true, force: true });
});

async function serve(onSay: SayHandler): Promise<void> {
  channel = createChannel({ dataDir, onSay, logger: recordingLogger() });
  await channel.start();
}

/** An environment that finds this test's socket and none of the machine's configuration. */
const env = () => ({
  HOME: join(root, 'home'),
  XDG_CONFIG_HOME: join(root, 'xdg-config'),
  CONFIGURATION_DIRECTORY: join(root, 'system-config'),
  CORTANA_DATA_DIR: dataDir,
});

function capture() {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  return { stream, text: () => text };
}

async function run(
  argv: string[],
  options: { input?: string; interactive?: boolean } = {},
): Promise<{ code: number; output: string; errors: string }> {
  const input = new PassThrough();
  input.end(options.input ?? '');
  const output = capture();
  const errors = capture();
  const code = await runCli({
    argv,
    env: env(),
    input,
    output: output.stream,
    errors: errors.stream,
    interactive: options.interactive ?? false,
  });
  return { code, output: output.text(), errors: errors.text() };
}

/** A turn that asks one question and says what the answer was. */
const asking: SayHandler = async (_text, conversation) =>
  (await conversation.ask('The agent wants to write Write. Allow it?', 'writes need a person'))
    ? 'went ahead'
    : 'did not';

describe('talking', () => {
  it('sends one message and prints the answer', async () => {
    await serve(async (text) => `you said ${text}`);

    const { code, output } = await run(['hello']);

    expect(code).toBe(EXIT_CODES.ok);
    expect(output).toBe('you said hello\n');
  });

  it('sends each line of piped input, in order', async () => {
    await serve(async (text) => `<${text}>`);

    const { output } = await run([], { input: 'one\n\ntwo\n' });

    expect(output).toBe('<one>\n<two>\n');
  });

  it('shows a prompt to a person at the keyboard', async () => {
    await serve(async () => 'hi');

    const { output } = await run([], { input: 'hello\n', interactive: true });

    expect(output).toContain('Ctrl-D to stop');
    expect(output).toContain('> hi\n');
  });

  it('prints a failed turn as a line, and says so in the exit code', async () => {
    await serve(async () => {
      throw new AppError('no model provider is configured', {
        category: 'config',
        code: 'no-runner-configured',
      });
    });

    const { code, output } = await run(['hello']);

    expect(code).toBe(EXIT_CODES.failed);
    expect(output).toContain('! no model provider is configured');
  });
});

describe('an approval', () => {
  it('is put to the person at the keyboard, and a yes is a yes', async () => {
    await serve(asking);

    const { output } = await run(['write it'], { input: 'y\n', interactive: true });

    expect(output).toContain('writes need a person');
    expect(output).toContain('Allow it? [y/N]');
    expect(output).toContain('went ahead');
  });

  it('takes anything but a yes as a no', async () => {
    await serve(asking);

    const { output } = await run(['write it'], { input: 'maybe\n', interactive: true });

    expect(output).toContain('did not');
  });

  it('is read from the same input as the conversation, in order', async () => {
    // The question arrives in the middle of a turn: the line after the message
    // is its answer, and the conversation carries on after it.
    await serve(asking);

    const { output } = await run([], { input: 'write it\ny\n', interactive: true });

    expect(output).toContain('went ahead');
  });

  it('is refused when nobody is at the keyboard, and says why', async () => {
    await serve(asking);

    const { output } = await run(['write it'], { input: 'y\n' });

    expect(output).toContain('nobody is at the keyboard');
    expect(output).toContain('did not');
  });

  it('is accepted unseen only when --approve was typed', async () => {
    await serve(asking);

    const { output } = await run(['--approve', 'write it']);

    expect(output).toContain('yes (--approve)');
    expect(output).toContain('went ahead');
  });
});

describe('when it cannot get through', () => {
  it('asks whether the daemon is running, without a stack trace', async () => {
    const { code, errors } = await run(['hello']);

    expect(code).toBe(EXIT_CODES.failed);
    expect(errors).toContain('Is the daemon running?');
    expect(errors).not.toContain('    at ');
  });

  it('points at the wrapper when the socket is not this user’s to open', async () => {
    // The server's case: the data directory is 0700 and belongs to the service.
    await serve(async () => 'unreachable');
    chmodSync(dataDir, 0o000);

    const { code, errors } = await run(['hello']);

    expect(code).toBe(EXIT_CODES.failed);
    expect(errors).toContain('installed with the service');
  });

  it('points at the wrapper when the configuration is not this user’s to read', async () => {
    const system = join(root, 'system-config');
    mkdirSync(system, { recursive: true });
    writeFileSync(join(system, 'config.toml'), '');
    chmodSync(join(system, 'config.toml'), 0o000);

    const { code, errors } = await run(['hello']);

    expect(code).toBe(EXIT_CODES.config);
    expect(errors).toContain('installed with the service');
  });
});
