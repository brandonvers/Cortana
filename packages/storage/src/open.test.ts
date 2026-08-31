import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAppError } from '@cortana/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from './open.ts';

let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-storage-'));
  dataDir = join(root, 'state');
});

afterEach(() => {
  chmodSync(root, 0o755);
  rmSync(root, { recursive: true, force: true });
});

describe('openStorage', () => {
  it('creates the data directory and the database inside it', () => {
    const storage = openStorage({ dataDir });

    expect(existsSync(dataDir)).toBe(true);
    expect(storage.path).toBe(join(dataDir, 'cortana.db'));
    expect(existsSync(storage.path)).toBe(true);
    storage.close();
  });

  it('keeps the data directory to its owner', () => {
    // Everything durable lives here, and on a shared machine it is nobody
    // else's business.
    openStorage({ dataDir }).close();

    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  });

  it('names the database after the product rather than hard-coding it', () => {
    // ADR-0002 requires renaming to stay cheap, so the file name is derived.
    expect(openStorage({ dataDir }).path.endsWith('cortana.db')).toBe(true);
  });
});

describe('the settings that are not negotiable', () => {
  it('has every required pragma in force', () => {
    const storage = openStorage({ dataDir });
    const read = (name: string) => storage.connection.pragma(name, { simple: true });

    expect(read('journal_mode')).toBe('wal');
    expect(read('synchronous')).toBe(2); // FULL, per ADR-0017
    expect(read('foreign_keys')).toBe(1);
    expect(read('busy_timeout')).toBe(5000);
    storage.close();
  });

  it('leaves WAL on the file, not just on the connection', () => {
    // journal_mode is the one that persists, so a second process finds it too.
    const storage = openStorage({ dataDir });
    storage.close();

    const fresh = new Database(join(dataDir, 'cortana.db'));
    expect(fresh.pragma('journal_mode', { simple: true })).toBe('wal');
    fresh.close();
  });

  it('pins what the driver already does, so a change to it is caught here', () => {
    // Only journal_mode is actually changed by openStorage; the other three
    // happen to match better-sqlite3's own defaults today. That makes this the
    // test that matters most: if the driver moves a default in a minor release,
    // this fails and says so, while the explicit settings above keep the
    // database correct in the meantime.
    const bare = new Database(join(root, 'bare.db'));

    expect(bare.pragma('journal_mode', { simple: true })).toBe('delete');
    expect(bare.pragma('synchronous', { simple: true })).toBe(2);
    expect(bare.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(bare.pragma('busy_timeout', { simple: true })).toBe(5000);
    bare.close();
  });

  it('changes journal_mode, which is the one the driver does not', () => {
    const storage = openStorage({ dataDir });

    expect(storage.connection.pragma('journal_mode', { simple: true })).toBe('wal');
    storage.close();
  });

  it('would notice a mistyped durability setting, which SQLite would not', () => {
    // The hazard the readback exists for, pinned as a test because it is
    // invisible in every other way. A typo in the pragma value throws nothing,
    // logs nothing, and silently drops FULL to NORMAL.
    const storage = openStorage({ dataDir });
    expect(storage.connection.pragma('synchronous', { simple: true })).toBe(2);

    expect(() => storage.connection.pragma('synchronous = FULLL')).not.toThrow();
    expect(storage.connection.pragma('synchronous', { simple: true })).toBe(1);

    storage.close();
  });
});

describe('when it cannot open', () => {
  it('says so when the data directory cannot be created', () => {
    // A file where the directory should be. The failure is reported against the
    // path rather than as a driver-level surprise.
    writeFileSync(join(root, 'occupied'), 'not a directory');

    try {
      openStorage({ dataDir: join(root, 'occupied') });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error) && error.category).toBe('storage');
      expect(isAppError(error) && error.code).toBe('data-dir-unusable');
    }
  });

  it('says so when the database file cannot be opened', () => {
    mkdirSync(dataDir, { recursive: true });
    // A directory where the database file should be: openable as a path,
    // impossible as a database.
    mkdirSync(join(dataDir, 'cortana.db'));

    try {
      openStorage({ dataDir });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('database-unopenable');
    }
  });
});

describe('closing', () => {
  it('folds the write-ahead log back into the file', () => {
    // So that a copy of the database file is a complete copy, which is what
    // makes a backup taken after a clean stop trustworthy.
    const storage = openStorage({ dataDir });
    storage.connection.exec('create table t (a integer)');
    storage.connection.exec('insert into t values (1)');
    expect(existsSync(`${storage.path}-wal`)).toBe(true);

    storage.close();

    expect(existsSync(`${storage.path}-wal`)).toBe(false);
    expect(existsSync(storage.path)).toBe(true);
  });

  it('leaves the data behind it', () => {
    const storage = openStorage({ dataDir });
    storage.connection.exec('create table t (a integer)');
    storage.connection.exec('insert into t values (42)');
    storage.close();

    const reopened = openStorage({ dataDir });
    expect(reopened.connection.prepare('select a from t').get()).toEqual({ a: 42 });
    reopened.close();
  });
});
