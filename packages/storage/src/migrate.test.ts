import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAppError, newInstanceId } from '@cortana/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateToLatest } from './migrate.ts';
import { openStorage, type Storage } from './open.ts';
import { instances } from './schema.ts';

let root: string;
let storage: Storage;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-migrate-'));
  storage = openStorage({ dataDir: join(root, 'state') });
});

afterEach(() => {
  storage.close();
  rmSync(root, { recursive: true, force: true });
});

function tableNames(): string[] {
  return (
    storage.connection
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

describe('migrateToLatest', () => {
  it('creates the schema on an empty database', () => {
    expect(tableNames()).toEqual([]);

    const result = migrateToLatest(storage);

    expect(result.applied).toBe(1);
    expect(result.total).toBe(1);
    expect(tableNames()).toContain('instances');
  });

  it('does nothing the second time', () => {
    // Every start after the first goes through this path, so "no-op" is the
    // common case rather than an edge one.
    migrateToLatest(storage);
    const again = migrateToLatest(storage);

    expect(again.applied).toBe(0);
    expect(again.total).toBe(1);
  });

  it('is a no-op across a close and reopen', () => {
    migrateToLatest(storage);
    const path = storage.path;
    storage.close();

    storage = openStorage({ dataDir: join(root, 'state') });
    expect(storage.path).toBe(path);
    expect(migrateToLatest(storage).applied).toBe(0);
  });

  it('refuses a database written by a newer build', () => {
    // The direction drizzle's own migrator does not cover: it applies what is
    // missing and says nothing about what is present and unrecognised. A
    // downgrade would otherwise run against a schema from the future.
    migrateToLatest(storage);
    storage.connection
      .prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)')
      .run('a-migration-from-a-later-build', 4_102_444_800_000); // 2100-01-01

    try {
      migrateToLatest(storage);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(isAppError(error) && error.category).toBe('storage');
      expect(isAppError(error) && error.code).toBe('database-ahead-of-binary');
      expect((error as Error).message).toContain('2100-01-01');
      expect((error as Error).message).toContain('newer build');
    }
  });

  it('refuses before applying anything, rather than half-migrating', () => {
    // The check runs first on purpose. Applying part of a migration set and then
    // discovering the database is from the future is the outcome the DoD names.
    storage.connection.exec(
      'create table __drizzle_migrations (id integer primary key, hash text, created_at numeric)',
    );
    storage.connection
      .prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)')
      .run('unknown', 4_102_444_800_000);

    expect(() => migrateToLatest(storage)).toThrowError(/newer build/);
    expect(tableNames()).not.toContain('instances');
  });

  it('reports a missing migration folder as a storage failure', () => {
    try {
      migrateToLatest(storage, join(root, 'no-such-folder'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('migration-journal-unreadable');
    }
  });
});

describe('the instances table', () => {
  beforeEach(() => {
    migrateToLatest(storage);
  });

  it('round-trips a row', () => {
    const id = newInstanceId();
    const startedAt = Date.now();
    storage.db.insert(instances).values({ id, version: '0.1.0-alpha.1', startedAt }).run();

    expect(storage.db.select().from(instances).all()).toEqual([
      { id, version: '0.1.0-alpha.1', startedAt, stoppedAt: null },
    ]);
  });

  it('leaves stoppedAt null until something sets it', () => {
    // A row with no stoppedAt is a process that never shut down cleanly, which
    // is the question this table exists to answer.
    const id = newInstanceId();
    storage.db.insert(instances).values({ id, version: '0.0.0', startedAt: 1 }).run();

    const [row] = storage.db.select().from(instances).all();
    expect(row?.stoppedAt).toBeNull();
  });

  it('sorts by identifier in the order the processes started', () => {
    // What the version 7 identifier buys: no second column and no second index
    // to ask "which run came first".
    const ids = [1_700_000_000_000, 1_700_000_060_000, 1_800_000_000_000].map((t) =>
      newInstanceId(t),
    );
    for (const [index, id] of ids.entries()) {
      storage.db.insert(instances).values({ id, version: '0.0.0', startedAt: index }).run();
    }

    const stored = storage.db.select().from(instances).orderBy(instances.id).all();
    expect(stored.map((row) => row.id)).toEqual(ids);
  });

  it('will not take the same identifier twice', () => {
    const id = newInstanceId();
    storage.db.insert(instances).values({ id, version: '0.0.0', startedAt: 1 }).run();

    expect(() =>
      storage.db.insert(instances).values({ id, version: '0.0.0', startedAt: 2 }).run(),
    ).toThrowError(/UNIQUE/);
  });
});
