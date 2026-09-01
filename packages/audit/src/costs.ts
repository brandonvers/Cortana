/**
 * What can honestly be said about cost, and the one number this refuses to
 * compute.
 *
 * ## Why there is no average
 *
 * [Spike 0009](../../../docs/spikes/0009-structured-output.md) repeated one
 * identical call — same model, same prompt, same schema — and measured
 * **$0.0201 and $0.6891**. Thirty-four times, on 1.4× the output tokens. The
 * cause was prompt-cache state: the expensive turn wrote 110,428 tokens of cache
 * and the cheap one wrote none, and **what selects between the regimes is not
 * known**.
 *
 * A mean over that is not a summary, it is a number with no referent. It would
 * be read as "a turn costs about this", and no turn costs about that. So the
 * spread is reported instead — the cheapest, the dearest, and the total — which
 * is the same information without the false middle.
 *
 * Anyone who wants a mean can divide two of the fields below. The point is not
 * to prevent that; it is not to endorse it by shipping it as a field.
 *
 * ## Why cache counters are part of a cost summary
 *
 * Because they are the only thing that explains the spread. A row of costs with
 * no cache figures beside it invites exactly the average this refuses to
 * provide.
 */

import type { Storage } from '@cortana/storage';
import { and, gte, lt, sql } from 'drizzle-orm';
import { auditTurns } from './schema.ts';

export interface CostWindow {
  /** Inclusive. */
  readonly since?: Date;
  /** Exclusive. */
  readonly until?: Date;
}

export interface CostSummary {
  readonly turns: number;
  readonly failed: number;
  /**
   * Turns the adapter reported no cost for.
   *
   * Not zero and not an error — the port documents a missing figure as normal —
   * but a total computed without them is a total over fewer turns than `turns`,
   * and a reader deserves to know by how many.
   */
  readonly turnsWithoutCost: number;

  readonly totalUsd: number;
  /** The cheapest and dearest turns that reported a cost. `null` when none did. */
  readonly cheapestUsd: number | null;
  readonly dearestUsd: number | null;

  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/**
 * Summarises the audit over a window.
 *
 * Reads run freely — ADR-0010 gates writes, not reads — so this does not go
 * through the writer.
 */
export function summariseCost(storage: Storage, window: CostWindow = {}): CostSummary {
  const bounds = [
    window.since ? gte(auditTurns.startedAt, window.since.getTime()) : undefined,
    window.until ? lt(auditTurns.startedAt, window.until.getTime()) : undefined,
  ].filter((clause) => clause !== undefined);

  const [row] = storage.db
    .select({
      turns: sql<number>`count(*)`,
      failed: sql<number>`sum(case when ${auditTurns.outcome} = 'failed' then 1 else 0 end)`,
      turnsWithoutCost: sql<number>`sum(case when ${auditTurns.costUsd} is null then 1 else 0 end)`,
      totalUsd: sql<number>`coalesce(sum(${auditTurns.costUsd}), 0)`,
      cheapestUsd: sql<number | null>`min(${auditTurns.costUsd})`,
      dearestUsd: sql<number | null>`max(${auditTurns.costUsd})`,
      inputTokens: sql<number>`coalesce(sum(${auditTurns.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${auditTurns.outputTokens}), 0)`,
      cacheReadTokens: sql<number>`coalesce(sum(${auditTurns.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<number>`coalesce(sum(${auditTurns.cacheWriteTokens}), 0)`,
    })
    .from(auditTurns)
    .where(bounds.length > 0 ? and(...bounds) : undefined)
    .all();

  return {
    turns: row?.turns ?? 0,
    failed: row?.failed ?? 0,
    turnsWithoutCost: row?.turnsWithoutCost ?? 0,
    totalUsd: row?.totalUsd ?? 0,
    cheapestUsd: row?.cheapestUsd ?? null,
    dearestUsd: row?.dearestUsd ?? null,
    inputTokens: row?.inputTokens ?? 0,
    outputTokens: row?.outputTokens ?? 0,
    cacheReadTokens: row?.cacheReadTokens ?? 0,
    cacheWriteTokens: row?.cacheWriteTokens ?? 0,
  };
}

/**
 * How wide the spread is, as a multiple.
 *
 * `null` when fewer than two turns reported a cost, or when the cheapest was
 * free — a ratio against zero is not a number anyone should be shown.
 *
 * This exists so the thing spike 0009 measured is visible rather than
 * rediscovered. If it comes back near 34, that is not an anomaly; it is the
 * documented behaviour of prompt caching, and no scheduling decision should be
 * made as though the next turn will cost what the last one did.
 */
export function costSpread(summary: CostSummary): number | null {
  const { cheapestUsd, dearestUsd } = summary;
  if (cheapestUsd === null || dearestUsd === null) return null;
  if (cheapestUsd <= 0) return null;
  return dearestUsd / cheapestUsd;
}
