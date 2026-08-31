/**
 * The tables M1 creates, which is one.
 *
 * The M1 plan is explicit that this milestone "creates only the tables M1 itself
 * uses", and it is worth restating why, because an empty-looking schema invites
 * someone to fill it in. Jobs, agents, messages and memories belong to the
 * milestones that build them; a schema written ahead of its consumer is a guess
 * that later has to be either honoured or migrated away from.
 *
 * That discipline also settles a coupling recorded in the outstanding list:
 * there is no vector table and no embedding column here, and `sqlite-vec` is not
 * loaded. ADR-0012 records the embedding dimension as a parameter rather than a
 * constant, and it stays live because the private corpus can still overturn
 * `bge-m3`. With nothing storing a vector, the number cannot be hard-coded by
 * forgetting about it.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * One row per time the daemon started.
 *
 * It exists in M1 because the crash test needs something true to assert about,
 * and because it answers a question an operator actually asks: did it stop
 * cleanly last time. A row with no `stoppedAt` is a process that did not get to
 * shut down — a kill, a power cut, or a crash — which is exactly the case
 * ADR-0013 says has to be cheap rather than impossible.
 */
export const instances = sqliteTable('instances', {
  /** A version 7 UUID, so the table sorts by when each process started. */
  id: text('id').primaryKey(),
  /** The build that was running. Which restart introduced a problem is a question. */
  version: text('version').notNull(),
  /** Epoch milliseconds. */
  startedAt: integer('started_at').notNull(),
  /** Epoch milliseconds, or null: null means this process never shut down cleanly. */
  stoppedAt: integer('stopped_at'),
});

export type InstanceRow = typeof instances.$inferSelect;
export type NewInstanceRow = typeof instances.$inferInsert;
