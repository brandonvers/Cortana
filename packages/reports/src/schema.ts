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

import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const requests = sqliteTable('requests', {
  /** A version 7 UUID, so requests sort by when they were opened. */
  id: text('id').primaryKey(),
  /**
   * When holding stops. ADR-0014's third rule: one stalled team cannot withhold
   * what its siblings finished. Epoch milliseconds.
   */
  deadlineAt: integer('deadline_at').notNull(),
  createdAt: integer('created_at').notNull(),
  /**
   * When the deadline notice went out — ADR-0014's third rule, delivered.
   *
   * Recorded because the notice can be empty. If every team stalled there is
   * nothing to deliver, and the main agent still has to be told, or the person
   * who asked is never answered at all. An empty delivery completes no report,
   * so without this column nothing would say it had happened, and it would go
   * out again on every pass.
   */
  timedOutAt: integer('timed_out_at'),
  /**
   * When every assignee's reports had been delivered, and nothing more is
   * waited for. Null while the request is open.
   */
  closedAt: integer('closed_at'),
});

/**
 * Who a request was given to — one row per agent.
 *
 * This replaced a count, and the count was the defect. Spike 0005 stored how
 * many reports a request expected, and a count cannot tell two reports from one
 * agent apart from one report each from two: an agent that reported twice
 * filled the number while another team said nothing, and the request was
 * delivered as complete with a team missing. It also cannot name who is
 * missing, and [ADR-0014](../../../docs/adr/0014-kernel-mediated-reports.md)'s
 * third rule requires exactly that — on timeout the main agent "is told
 * explicitly what is missing and why". The ADR said the kernel "has to know what
 * was dispatched to know when everything is back"; a number is not what was
 * dispatched.
 */
export const requestAssignments = sqliteTable(
  'request_assignments',
  {
    requestId: text('request_id').notNull(),
    /** The agent the work was given to, by roster name. */
    assignee: text('assignee').notNull(),
  },
  (table) => [primaryKey({ columns: [table.requestId, table.assignee] })],
);

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
     * `blocker` and `decision` are ADR-0014's first rule — "a blocker or a
     * decision request is delivered immediately" — and are kept apart because
     * they ask the main agent different things: one team is stuck, the other
     * needs a call only the main agent can make. Spike 0005 had only the first.
     *
     * Neither counts as the assignee's report. A team that was blocked and then
     * unblocked still owes the report it was asked for.
     */
    kind: text('kind', { enum: ['report', 'blocker', 'decision'] }).notNull(),
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
