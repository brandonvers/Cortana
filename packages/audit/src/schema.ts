/**
 * What a turn did, kept.
 *
 * ## Why the table lives here and not in `@cortana/storage`
 *
 * M1 put its one table in the storage package because M1 had one. The M2 plan
 * changed that: a table lives with the code that owns it, and migrations stay
 * central so there is still **one ordered migration history** — which is the
 * property [ADR-0010](../../../docs/adr/0010-sqlite-storage.md) actually cares
 * about. `packages/storage/drizzle.config.ts` collects this file along with its
 * own.
 *
 * ## What is in it, and what that means
 *
 * [ADR-0019](../../../docs/adr/0019-the-audit-stores-what-was-said.md) decided
 * this deliberately: **prompts and responses are stored in full.** An audit
 * exists to answer *why did it do that*, and that is not reconstructible from a
 * hash. Two consequences follow and are written down rather than discovered:
 *
 * - **This table will contain credentials.** M1's `Secret` type keeps them out
 *   of log lines by closing every route from an object to text. A prompt is not
 *   an object being formatted — it is what the operator typed. There is no type
 *   that can help here.
 * - **A backup carries the transcript.** One database file was
 *   [ADR-0010](../../../docs/adr/0010-sqlite-storage.md)'s deliberate choice, and
 *   this is now part of what that file holds.
 *
 * Retention is a number of days rather than "forever", because unbounded
 * retention is not a decision to keep everything — it is a decision to defer
 * deletion to the day the disk fills.
 */

import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const auditTurns = sqliteTable(
  'audit_turns',
  {
    /**
     * A version 7 UUID, so the table sorts by when the turn happened and the
     * identifier is itself the cursor for "what has happened since".
     */
    id: text('id').primaryKey(),
    /** Which run of the daemon. Joins to `instances`. */
    instanceId: text('instance_id').notNull(),
    /** Which model session. Groups a conversation without a second table. */
    sessionId: text('session_id').notNull(),
    /**
     * Which adapter ran it.
     *
     * Recorded rather than assumed because the whole point of
     * [ADR-0001](../../../docs/adr/0001-model-access-behind-a-port.md) is that
     * this can change, and an audit that cannot say which one answered would be
     * unable to explain a difference in behaviour across the change.
     */
    adapter: text('adapter').notNull(),
    /**
     * The tier asked for, not the model that served it.
     *
     * ADR-0015 already noted that tier aliases "resolve to snapshots that change
     * underneath this record". The tier is what this system chose; the snapshot
     * is what the provider chose, and only one of those is ours to record
     * truthfully.
     */
    tier: text('tier').notNull(),
    /** `prose` or `structured`. */
    kind: text('kind').notNull(),
    prompt: text('prompt').notNull(),
    /** The text answer, or the structured value as JSON. Empty when the turn failed. */
    response: text('response').notNull(),
    /** `ok` or `failed`. */
    outcome: text('outcome').notNull(),
    /** The `AppError` code when it failed, so a failure can be counted by kind. */
    errorCode: text('error_code'),

    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    /**
     * The cache counters travel with the cost, and not for completeness.
     * [Spike 0009](../../../docs/spikes/0009-structured-output.md) repeated one
     * identical call and measured $0.0201 and $0.6891 — 34× — with output tokens
     * differing by 1.4×, on cache state alone. A cost row without them invites
     * an average, and the average of a 34× spread describes nothing.
     */
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    cacheWriteTokens: integer('cache_write_tokens').notNull(),
    /** Null when the adapter had no figure, which is a normal state. */
    costUsd: real('cost_usd'),

    startedAt: integer('started_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
  },
  (table) => [
    // The two questions actually asked of this table: what did this conversation
    // do, and what happened lately. `id` already sorts by time, so the second
    // index is on the wall-clock field a retention sweep filters on.
    index('audit_turns_session').on(table.sessionId),
    index('audit_turns_started_at').on(table.startedAt),
  ],
);

export type AuditTurnRow = typeof auditTurns.$inferSelect;
export type NewAuditTurnRow = typeof auditTurns.$inferInsert;
