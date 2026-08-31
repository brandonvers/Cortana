/**
 * Applying migrations, and refusing to guess.
 *
 * drizzle-kit generates the SQL and drizzle's migrator applies whatever has not
 * run yet, which covers the ordinary case and one of the two directions that
 * matter. It does not cover the other: a database carrying migrations this build
 * has never heard of — a downgrade, or a branch someone else's build wrote — is
 * accepted without comment, and the schema then diverges from the code silently.
 *
 * So the applied set is compared against the local one first. drizzle records
 * each migration's `created_at` as the `when` timestamp from the journal it was
 * generated with, which was confirmed by reading both after a real migration
 * rather than inferred from the source. A timestamp in the database that is not
 * in this build's journal came from a build this one does not have.
 *
 * **What this does not catch:** a migration file edited after it was applied.
 * drizzle decides what to run by timestamp, so an edit to an already-applied
 * file is ignored, and the check above sees a timestamp it recognises. The
 * answer to that is to generate a new migration rather than edit an old one —
 * which is what `docs/RELEASING.md` requires from the first beta anyway, since a
 * forward guarantee and an edited history cannot both hold.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppError } from '@cortana/core';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Storage } from './open.ts';

/** The folder drizzle-kit writes into, next to this package's source. */
export const MIGRATIONS_FOLDER = resolve(import.meta.dirname, '..', 'migrations');

const BOOKKEEPING_TABLE = '__drizzle_migrations';

export interface MigrationResult {
  /** How many ran during this call. Zero on every start after the first. */
  readonly applied: number;
  /** How many are recorded as applied afterwards. */
  readonly total: number;
}

interface JournalEntry {
  readonly when: number;
  readonly tag: string;
}

function readJournal(folder: string): JournalEntry[] {
  const path = join(folder, 'meta', '_journal.json');
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: JournalEntry[] };
    return parsed.entries ?? [];
  } catch (error) {
    throw new AppError(`cannot read the migration journal at ${path}`, {
      category: 'storage',
      code: 'migration-journal-unreadable',
      detail: { path },
      cause: error,
    });
  }
}

/** Timestamps already applied, or an empty list if nothing has ever been applied. */
function appliedTimestamps(storage: Storage): number[] {
  const exists = storage.connection
    .prepare("select name from sqlite_master where type = 'table' and name = ?")
    .get(BOOKKEEPING_TABLE);
  if (!exists) return [];

  const rows = storage.connection
    .prepare(`select created_at as createdAt from ${BOOKKEEPING_TABLE}`)
    .all() as { createdAt: number }[];
  return rows.map((row) => row.createdAt);
}

export function migrateToLatest(
  storage: Storage,
  folder: string = MIGRATIONS_FOLDER,
): MigrationResult {
  const journal = readJournal(folder);
  const known = new Set(journal.map((entry) => entry.when));
  const applied = appliedTimestamps(storage);

  const unknown = applied.filter((when) => !known.has(when));
  if (unknown.length > 0) {
    const newest = Math.max(...unknown);
    throw new AppError(
      `the database at ${storage.path} has ${unknown.length} migration(s) this build does not ` +
        `know about, the newest from ${new Date(newest).toISOString()}. It was written by a ` +
        'newer build. Upgrade rather than migrating it backwards.',
      {
        category: 'storage',
        code: 'database-ahead-of-binary',
        detail: {
          path: storage.path,
          unknown: unknown.length,
          knownToThisBuild: journal.length,
          newest: new Date(newest).toISOString(),
        },
      },
    );
  }

  const before = applied.length;
  try {
    migrate(storage.db, { migrationsFolder: folder });
  } catch (error) {
    throw new AppError(`migrating the database at ${storage.path} failed`, {
      category: 'storage',
      code: 'migration-failed',
      detail: { path: storage.path, appliedBefore: before },
      cause: error,
    });
  }

  const total = appliedTimestamps(storage).length;
  return { applied: total - before, total };
}
