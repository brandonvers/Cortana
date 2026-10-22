import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '@cortana/config';
import { recordingLogger } from '@cortana/core/testing';
import { instances, openStorage } from '@cortana/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningKernel, startKernel } from './kernel.ts';

let root: string;
let config: Config;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-kernel-'));
  config = {
    dataDir: join(root, 'state'),
    log: { level: 'info' },
    language: 'en',
    audit: { retentionDays: 90 },
    agent: {
      persona: 'You are Cortana.',
      tier: 'balanced',
      tools: [],
      actions: [],
      readable: [],
      writable: [],
      confirm: 'writes',
    },
    roster: { directory: '/etc/cortana/agents', idleTtlMs: 300_000, maxAwake: 4 },
    shutdown: { timeoutMs: 5_000 },
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const start = (): Promise<RunningKernel> =>
  startKernel({ config, logger: recordingLogger(), version: '0.1.0-alpha.1' });

function rows() {
  const storage = openStorage({ dataDir: config.dataDir });
  try {
    return storage.db.select().from(instances).all();
  } finally {
    storage.close();
  }
}

describe('starting', () => {
  it('opens the database, migrates it, and comes up running', async () => {
    const kernel = await start();

    expect(kernel.lifecycle.state).toBe('running');
    expect(kernel.storage.path).toBe(join(config.dataDir, 'cortana.db'));
    expect(kernel.writer.depth).toBe(0);
    expect(kernel.bus.closed).toBe(false);

    await kernel.stop('test');
  });

  it('records the run before anything else can write', async () => {
    const kernel = await start();
    await kernel.stop('test');

    const [row] = rows();
    expect(row?.id).toBe(kernel.instanceId);
    expect(row?.version).toBe('0.1.0-alpha.1');
    expect(row?.startedAt).toBeGreaterThan(0);
  });

  it('announces itself on the bus', async () => {
    const kernel = await start();
    // Subscribing after start means the event has already gone by, which is
    // itself the contract: this bus does not replay.
    const seen: string[] = [];
    kernel.bus.subscribe('kernel.stopping', ({ reason }) => {
      seen.push(reason);
    });

    await kernel.stop('a reason');

    expect(seen).toEqual(['a reason']);
  });

  it('refuses to start on a database written by a newer build', async () => {
    const first = await start();
    await first.stop('test');

    const storage = openStorage({ dataDir: config.dataDir });
    storage.connection
      .prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)')
      .run('from-the-future', 4_102_444_800_000);
    storage.close();

    await expect(start()).rejects.toThrow(/failed to start/);
  });
});

describe('stopping in the order that matters', () => {
  it('marks the run as stopped, which only works if it writes before the writer drains', async () => {
    // The ordering constraint with teeth. The instance record's stop() is a
    // write; put it any later in the sequence and every clean shutdown would be
    // recorded as an unclean one.
    const kernel = await start();

    const report = await kernel.stop('test');

    expect(report.clean).toBe(true);
    expect(report.components.map((c) => c.name)).toEqual([
      // The socket first: nothing new arrives while the rest is coming down.
      'channel',
      // Then the session, because a turn in flight is a write that has not
      // happened yet, and the writer is still two entries below.
      'agent',
      'instance-record',
      'bus',
      'writer',
      'storage',
    ]);
    expect(rows()[0]?.stoppedAt).toBeGreaterThan(0);
  });

  it('leaves stoppedAt null when the process never gets to stop', async () => {
    // What a crash looks like from the outside, and what step 7's kill test
    // will assert against.
    const kernel = await start();
    kernel.storage.close();

    expect(rows()[0]?.stoppedAt).toBeNull();
  });

  it('closes the database, folding the write-ahead log back in', async () => {
    const kernel = await start();
    await kernel.stop('test');

    // Reopening proves the file is intact and the sequence really closed it.
    const reopened = openStorage({ dataDir: config.dataDir });
    expect(reopened.db.select().from(instances).all()).toHaveLength(1);
    reopened.close();
  });

  it('refuses writes after the writer has drained', async () => {
    const kernel = await start();
    await kernel.stop('test');

    await expect(kernel.writer.write('too late', () => 1)).rejects.toThrow(/shutting down/);
  });

  it('is safe to stop twice', async () => {
    const kernel = await start();

    const [first, second] = await Promise.all([kernel.stop('one'), kernel.stop('two')]);

    expect(first).toBe(second);
    expect(rows()).toHaveLength(1);
  });
});

describe('health', () => {
  it('reports every component, and the database by asking it', async () => {
    const kernel = await start();

    const report = await kernel.health();

    expect(report.status).toBe('ok');
    expect(report.components.map((c) => c.name).sort()).toEqual([
      'agent',
      'bus',
      'channel',
      'instance-record',
      'storage',
      'writer',
    ]);

    await kernel.stop('test');
  });

  it('turns failing when the database has gone', async () => {
    const kernel = await start();
    kernel.storage.connection.close();

    expect((await kernel.health()).status).toBe('failing');
  });
});
