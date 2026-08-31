import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAppError, newInstanceId } from '@cortana/core';
import { manualClock } from '@cortana/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateToLatest } from './migrate.ts';
import { openStorage, type Storage } from './open.ts';
import { instances } from './schema.ts';
import { createWriter, type Writer } from './writer.ts';

let root: string;
let storage: Storage;
let writer: Writer;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-writer-'));
  storage = openStorage({ dataDir: join(root, 'state') });
  migrateToLatest(storage);
  storage.connection.exec('create table counter (n integer not null)');
  storage.connection.exec('insert into counter values (0)');
  writer = createWriter({ storage });
});

afterEach(() => {
  storage.close();
  rmSync(root, { recursive: true, force: true });
});

const readCounter = () =>
  (storage.connection.prepare('select n from counter').get() as { n: number }).n;

describe('the hazard this exists for', () => {
  it('loses updates when a write unit spans an await and nothing serialises it', async () => {
    // Not a test of the writer — a test of the problem, kept next to the
    // solution so that the next person to ask "is the queue doing anything"
    // has the answer in front of them. Without it, the assertion below that
    // twenty concurrent writes produce twenty increments looks like it is
    // testing arithmetic.
    const ungated = async () => {
      const n = readCounter();
      await Promise.resolve();
      storage.connection.prepare('update counter set n = ?').run(n + 1);
    };

    await Promise.all([ungated(), ungated(), ungated()]);

    expect(readCounter()).toBeLessThan(3);
  });
});

describe('serialising concurrent writers', () => {
  // The debt spike 0005 recorded against itself: "One writer. The design
  // mandates a single serialised writer, so contention was not exercised. It
  // should be, once the kernel's writer queue exists."
  //
  // What this proves, precisely: units survive contention **because they are
  // synchronous**, not because they are queued. Removing the queueing and
  // running every unit inline leaves this test passing — which is how that was
  // established rather than argued. The two tests after it are the ones that
  // fail when the queue goes, and they are about ordering and depth.
  it('loses nothing under twenty concurrent read-modify-writes', async () => {
    const bump = () =>
      writer.write('bump', ({ connection }) => {
        const n = (connection.prepare('select n from counter').get() as { n: number }).n;
        connection.prepare('update counter set n = ?').run(n + 1);
        return n + 1;
      });

    const results = await Promise.all(Array.from({ length: 20 }, bump));

    expect(readCounter()).toBe(20);
    // Every unit saw the previous one's committed value, so the returned
    // values are the sequence rather than twenty copies of 1.
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('actually queues them rather than getting lucky', async () => {
    // If each unit ran inline the depth would never exceed one, and the test
    // above would pass without the writer doing anything.
    const work = Array.from({ length: 20 }, () => writer.write('x', () => readCounter()));
    expect(writer.depth).toBe(20);

    await Promise.all(work);
    expect(writer.stats.maxDepth).toBe(20);
    expect(writer.depth).toBe(0);
  });

  it('runs them in the order they were asked for', async () => {
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => writer.write(`unit-${i}`, () => order.push(i))),
    );

    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('does not gate reads', async () => {
    // ADR-0010: reads run freely. A read taken while units are queued sees the
    // committed state and does not wait for them.
    const queued = Array.from({ length: 5 }, () =>
      writer.write('bump', ({ connection }) => {
        const n = (connection.prepare('select n from counter').get() as { n: number }).n;
        connection.prepare('update counter set n = ?').run(n + 1);
      }),
    );

    expect(writer.depth).toBe(5);
    expect(readCounter()).toBe(0);

    await Promise.all(queued);
    expect(readCounter()).toBe(5);
  });
});

describe('each unit is a transaction', () => {
  it('rolls the whole unit back when part of it fails', async () => {
    await expect(
      writer.write('two inserts then a problem', ({ db }) => {
        db.insert(instances).values({ id: newInstanceId(), version: 'a', startedAt: 1 }).run();
        db.insert(instances).values({ id: newInstanceId(), version: 'b', startedAt: 2 }).run();
        throw new Error('changed my mind');
      }),
    ).rejects.toThrow('changed my mind');

    expect(storage.db.select().from(instances).all()).toEqual([]);
  });

  it('keeps taking work after one unit fails', async () => {
    await expect(
      writer.write('doomed', () => {
        throw new Error('no');
      }),
    ).rejects.toThrow('no');

    await expect(writer.write('fine', () => 'ok')).resolves.toBe('ok');
    expect(writer.stats.failed).toBe(1);
    expect(writer.stats.completed).toBe(1);
  });

  it('does not let one caller’s failure roll back another’s work', async () => {
    const results = await Promise.allSettled([
      writer.write('good', ({ db }) =>
        db.insert(instances).values({ id: newInstanceId(), version: 'kept', startedAt: 1 }).run(),
      ),
      writer.write('bad', () => {
        throw new Error('mine only');
      }),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(storage.db.select().from(instances).all()).toHaveLength(1);
  });
});

describe('the synchronous contract', () => {
  it('refuses a unit that returns a promise, and rolls it back', async () => {
    // The failure the whole design rests on avoiding: the transaction commits
    // when the function returns, so anything awaited inside runs afterwards.
    const attempt = writer.write('async by mistake', async ({ db }) => {
      db.insert(instances).values({ id: newInstanceId(), version: 'x', startedAt: 1 }).run();
      return 'never reaches the caller';
    });

    await expect(attempt).rejects.toThrow(/must be synchronous/);
    try {
      await attempt;
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('asynchronous-write-unit');
      expect(isAppError(error) && error.category).toBe('internal');
    }
    expect(storage.db.select().from(instances).all()).toEqual([]);
  });

  it('refuses a write started from inside another write', async () => {
    let inner: Promise<unknown> | null = null;

    await writer.write('outer', () => {
      inner = writer.write('inner', () => 'nope');
    });

    await expect(inner).rejects.toThrow(/inside another write unit/);
    try {
      await inner;
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('nested-write-unit');
    }
  });
});

describe('draining', () => {
  it('finishes what it accepted', async () => {
    const queued = Array.from({ length: 8 }, () =>
      writer.write('bump', ({ connection }) => {
        const n = (connection.prepare('select n from counter').get() as { n: number }).n;
        connection.prepare('update counter set n = ?').run(n + 1);
      }),
    );

    await writer.drain();

    expect(readCounter()).toBe(8);
    await Promise.all(queued);
    expect(writer.depth).toBe(0);
  });

  it('refuses new work once draining', async () => {
    const drained = writer.drain();
    const rejected = writer.write('too late', () => 'x');

    await expect(rejected).rejects.toThrow(/shutting down/);
    try {
      await rejected;
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('writer-draining');
      expect(isAppError(error) && error.category).toBe('storage');
    }
    await drained;
  });

  it('resolves immediately when there is nothing outstanding', async () => {
    await expect(writer.drain()).resolves.toBeUndefined();
    expect(writer.draining).toBe(true);
  });
});

describe('what it counts', () => {
  it('reports the time spent inside units, measured on the clock it was given', async () => {
    const clock = manualClock();
    const timed = createWriter({ storage, clock });

    await timed.write('slow', () => clock.advance(7));
    await timed.write('slower', () => clock.advance(11));

    expect(timed.stats.busyMs).toBe(18);
    expect(timed.stats.completed).toBe(2);
    expect(timed.stats.enqueued).toBe(2);
    expect(timed.stats.failed).toBe(0);
  });
});
