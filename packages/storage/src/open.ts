/**
 * Opening the database, and proving the settings took.
 *
 * The PRAGMAs below are not preferences. WAL and `synchronous = FULL` are what
 * spike 0005 actually measured when it killed a writing process four times per
 * platform and lost nothing acknowledged, and ADR-0017 makes that configuration
 * the one production runs rather than a near neighbour of it.
 *
 * Each is read back after being set, because one class of failure here is
 * completely silent. Measured on SQLite 3.53.4 rather than assumed:
 *
 *   PRAGMA synchronous = FULL    -> synchronous reads 2   (FULL)
 *   PRAGMA synchronous = FULLL   -> no error thrown, and synchronous reads 1
 *
 * A **typo in the value** does not throw, does not warn, and leaves the setting
 * at NORMAL. So a single mistyped character in this file would quietly give up
 * the durability guarantee ADR-0017 makes and the whole design rests on, and
 * nothing anywhere would say so — until a power cut, months later, cost a
 * transaction nobody could trace back to it.
 *
 * The other failure modes do throw, which was also measured: a read-only
 * database rejects `journal_mode = WAL` with "attempt to write a readonly
 * database", and leaving WAL from inside a transaction throws as well. Those
 * would be caught with or without a readback. The silent one is the reason this
 * code has one.
 *
 * Setting a durability property and not checking it is the same class of mistake
 * as a check that does not check, which this repository has now found three
 * times in a month.
 *
 * ## Only one of the four actually changes anything
 *
 * Measured on better-sqlite3 13.0.3, which sets its own defaults on every
 * connection rather than leaving SQLite's:
 *
 *   journal_mode   delete   ->  wal    <- the only one this code changes
 *   synchronous    2        ->  2
 *   foreign_keys   1        ->  1
 *   busy_timeout   5000     ->  5000
 *
 * All four are still set explicitly, and that is the point rather than an
 * oversight: three of them are currently correct because of a **dependency's**
 * choice, and a dependency's default can move in a minor release without anyone
 * here noticing. Stating them makes them this project's decisions. The readback
 * then holds them true no matter who set them.
 *
 * (5000 ms for `busy_timeout` was chosen before that table was measured. That it
 * matches the driver's default is a coincidence, not a derivation.)
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, PRODUCT_NAME } from '@cortana/core';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.ts';

/** Derived rather than written down, because ADR-0002 requires renaming to stay cheap. */
const FILE_NAME = `${PRODUCT_NAME.toLowerCase()}.db`;

interface Pragma {
  readonly set: string;
  readonly read: string;
  readonly expect: string | number;
  readonly why: string;
}

const REQUIRED: readonly Pragma[] = [
  {
    set: 'journal_mode = WAL',
    read: 'journal_mode',
    expect: 'wal',
    why: 'readers do not block the writer, and a crash recovers from the log',
  },
  {
    set: 'synchronous = FULL',
    read: 'synchronous',
    // SQLITE_SYNC_FULL. The readback is numeric even though the value is set by name.
    expect: 2,
    why: 'ADR-0017 — durability is not traded for throughput, and not configurable',
  },
  {
    set: 'foreign_keys = ON',
    read: 'foreign_keys',
    expect: 1,
    why: 'off in SQLite itself, on in better-sqlite3 — so state it rather than inherit it',
  },
  {
    set: 'busy_timeout = 5000',
    read: 'busy_timeout',
    expect: 5000,
    why: 'a checkpoint can still collide with a reader; wait rather than fail',
  },
];

export interface Storage {
  /** The typed query layer. */
  readonly db: BetterSQLite3Database<typeof schema>;
  /**
   * The driver underneath.
   *
   * Exposed because ADR-0010 says full-text and vector queries are hand-written
   * SQL, and because migrations and the PRAGMA checks work at this level.
   */
  readonly connection: Database.Database;
  readonly path: string;
  close(): void;
}

export interface OpenOptions {
  /** Where durable state lives. Created if absent. */
  readonly dataDir: string;
}

function verify(connection: Database.Database, pragma: Pragma): void {
  const actual = connection.pragma(pragma.read, { simple: true });
  const matches =
    typeof actual === 'string' && typeof pragma.expect === 'string'
      ? actual.toLowerCase() === pragma.expect
      : actual === pragma.expect;

  if (!matches) {
    throw new AppError(
      `SQLite did not accept ${pragma.set} — ${pragma.read} reads ${String(actual)}, ` +
        `expected ${String(pragma.expect)} (${pragma.why})`,
      {
        category: 'storage',
        code: 'pragma-not-applied',
        detail: { pragma: pragma.read, expected: String(pragma.expect), actual: String(actual) },
      },
    );
  }
}

export function openStorage(options: OpenOptions): Storage {
  // 0o700: this directory holds everything durable, and on a shared machine the
  // contents are nobody else's business.
  try {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new AppError(`cannot create the data directory at ${options.dataDir}`, {
      category: 'storage',
      code: 'data-dir-unusable',
      detail: { dataDir: options.dataDir },
      cause: error,
    });
  }

  const path = join(options.dataDir, FILE_NAME);
  let connection: Database.Database;
  try {
    connection = new Database(path);
  } catch (error) {
    throw new AppError(`cannot open the database at ${path}`, {
      category: 'storage',
      code: 'database-unopenable',
      detail: { path },
      cause: error,
    });
  }

  try {
    for (const pragma of REQUIRED) {
      connection.pragma(pragma.set);
      verify(connection, pragma);
    }
  } catch (error) {
    connection.close();
    throw error;
  }

  return {
    db: drizzle(connection, { schema }),
    connection,
    path,
    close: () => {
      // Fold the write-ahead log back into the database file so that a copy of
      // it is a complete copy. A failure here is not a reason to leave the
      // connection open — the data is already durable either way.
      try {
        connection.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // Nothing to do about it, and nothing lost by it.
      }
      connection.close();
    },
  };
}
