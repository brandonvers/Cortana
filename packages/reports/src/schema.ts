/**
 * The durable half of [ADR-0014](../../../docs/adr/0014-kernel-mediated-reports.md):
 * a request, and the reports that come back for it.
 *
 * ## Why there is no `effects` table
 *
 * [Spike 0005](../../../docs/spikes/0005-durable-bus.md) kept a separate table
 * recording which messages had "had effect", because its effect was an
 * arbitrary function and the table was the only place to remember that it had
 * run. Here the effect is known — a report being delivered — so the report's own
 * `state` is that record, and completing one is a single conditional update
 * that changes a row or does not. One table saying a thing once, rather than two
 * that can disagree after a crash between their writes.
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const requests = sqliteTable('requests', {
  /** A version 7 UUID, so requests sort by when they were opened. */
  id: text('id').primaryKey(),
  /**
   * How many reports this request is waiting for.
   *
   * The number ADR-0014's second rule is about — "held until the request's
   * outstanding work is done" — and the thing the ADR warned costs something:
   * "the kernel now needs a per-request model of outstanding work … it has to
   * know what was dispatched to know when everything is back."
   */
  expected: integer('expected').notNull(),
  /**
   * When holding stops. ADR-0014's third rule: one stalled team cannot withhold
   * what its siblings finished. Epoch milliseconds.
   */
  deadlineAt: integer('deadline_at').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const reports = sqliteTable(
  'reports',
  {
    /**
     * Minted by whoever sends the report, not by this store.
     *
     * That is what makes a retried submission harmless: a sender that crashed
     * after writing and before learning it had written sends the same id again,
     * and the second insert changes nothing. Spike 0005 measured that direction
     * happening — 38 records on disk to 37 acknowledged — and called it the safe
     * one only because a retry is idempotent.
     */
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull(),
    /** Which agent sent it. */
    sender: text('sender').notNull(),
    /**
     * `blocker` is ADR-0014's first rule: delivered immediately, because a team
     * that is stuck does not wait for its siblings.
     */
    kind: text('kind', { enum: ['report', 'blocker'] }).notNull(),
    /** The report itself, as JSON. Validated where a model produced it, not here. */
    payload: text('payload').notNull(),
    state: text('state', { enum: ['pending', 'leased', 'delivered'] })
      .notNull()
      .default('pending'),
    /** The daemon instance holding the lease, so a restart knows whose it was. */
    leaseOwner: text('lease_owner'),
    leaseUntil: integer('lease_until'),
    /** How many times it has been leased. A number that keeps growing is a symptom. */
    attempts: integer('attempts').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    deliveredAt: integer('delivered_at'),
  },
  (table) => [
    index('reports_request_idx').on(table.requestId),
    index('reports_state_idx').on(table.state),
  ],
);

export type RequestRow = typeof requests.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;
