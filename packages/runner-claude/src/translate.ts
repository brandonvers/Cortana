/**
 * Everything the adapter does that is a pure function of the provider's data.
 *
 * It is separate from the adapter for a reason the M2 plan already decided: **CI
 * never calls the provider.** It has no credential and is not getting one —
 * ADR-0001's whole shape is that this project never handles provider
 * credentials, which applies to its own build as much as to a user — and spike
 * 0009 measured an identical call costing $0.0201 and $0.6891, so a suite that
 * called out on every pull request would have a bill scaling with the test count.
 *
 * What is left is that the interesting half of an adapter is translation: a model
 * name, a cost that arrives cumulative and has to be made per-turn, a utilization
 * on the wrong scale, a failure that arrives as a subtype string. That half is
 * tested on every commit; the half needing a live provider is run by hand.
 */

import { AppError } from '@cortana/core';
import type { AccountUsage, ModelTier, TurnUsage, UsageWindow } from '@cortana/runner';

/**
 * Which model each tier means.
 *
 * Aliases rather than dated snapshots, so the framework follows the provider's
 * current model for a tier instead of pinning to one that ages out. ADR-0015
 * already noted the cost: "the rows name tier aliases, which resolve to snapshots
 * that change underneath this record" — which is why the tier a turn ran at is
 * recorded in the audit rather than inferred later.
 */
export const DEFAULT_MODELS: Readonly<Record<ModelTier, string>> = {
  fast: 'haiku',
  balanced: 'sonnet',
  deep: 'opus',
};

/** A result message, narrowed to what this adapter reads. */
export interface ProviderResult {
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly result?: unknown;
  readonly total_cost_usd?: unknown;
  readonly usage?: Record<string, unknown>;
  readonly structured_output?: unknown;
  readonly num_turns?: unknown;
}

const asCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/**
 * Turns one result message into this turn's usage.
 *
 * Two things here are the provider's shape rather than the port's, and both were
 * read from the SDK's typings rather than assumed.
 *
 * **The cost arrives cumulative.** In a streaming-input session `total_cost_usd`
 * is "the running total so far", so a per-turn figure is a difference. It can go
 * backwards — the typings say a resumed session starts fresh and a mid-session
 * clear resets it — so a negative difference is reported as zero rather than as a
 * refund.
 *
 * **The token counts are per-turn**, on the same message, from a different field.
 * Reading tokens from the cumulative one, or cost from the per-turn one, produces
 * numbers that look plausible and are wrong.
 */
export function usageFrom(result: ProviderResult, previousTotalCostUsd: number): TurnUsage {
  const usage = result.usage ?? {};
  const total = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null;
  const delta = total === null ? null : Math.max(0, total - previousTotalCostUsd);

  return {
    inputTokens: asCount(usage['input_tokens']),
    outputTokens: asCount(usage['output_tokens']),
    cacheReadTokens: asCount(usage['cache_read_input_tokens']),
    cacheWriteTokens: asCount(usage['cache_creation_input_tokens']),
    costUsd: delta,
  };
}

/** The running total to carry forward, or the previous one when none was reported. */
export function totalCostFrom(result: ProviderResult, previous: number): number {
  return typeof result.total_cost_usd === 'number' && result.total_cost_usd >= previous
    ? result.total_cost_usd
    : previous;
}

/**
 * The error a failed turn should raise, or `null` when the turn succeeded.
 *
 * `error_max_turns` gets its own sentence because ADR-0015 spent a section on it:
 * it is what a turn budget too small for the structured-output carrier looks
 * like, it names nothing about that cause, and a vague prompt produces the same
 * symptom for an entirely different reason. Both belong in the message, because
 * whoever reads it at the time will not have the ADR open.
 */
export function failureFrom(result: ProviderResult): AppError | null {
  const subtype = typeof result.subtype === 'string' ? result.subtype : 'unknown';
  if (result.is_error !== true && subtype === 'success') return null;

  const explanations: Record<string, string> = {
    error_max_turns:
      'the turn ran out of turns. Two unrelated causes look identical here: a budget ' +
      'too small for the structured-output carrier turn, or a prompt vague enough that ' +
      'the model asked for clarification instead of answering',
    error_max_budget_usd: 'the turn hit the cost ceiling the adapter was configured with',
    error_max_structured_output_retries:
      'the provider gave up trying to produce a value matching the schema',
  };

  const detail = explanations[subtype];
  return new AppError(
    `the provider ended the turn with "${subtype}"${detail ? ` — ${detail}` : ''}`,
    {
      category: 'provider',
      code: 'turn-failed',
      detail: { subtype, turns: asCount(result.num_turns) },
    },
  );
}

/** The provider's usage payload, narrowed to what this adapter reads. */
export interface ProviderUsagePayload {
  readonly rate_limits_available?: unknown;
  readonly subscription_type?: unknown;
  readonly rate_limits?: Record<string, unknown> | null;
}

/**
 * Normalises the account meter onto the port's scale.
 *
 * Spike 0013 found the provider reporting the same quantity two ways — the usage
 * endpoint gives `87`, the pushed event gives `0.87` — and called a mistake here
 * "a factor of a hundred in a governor's arithmetic". The port fixes 0 to 1, so
 * this is where the hundred is divided out: once, in a function with a test.
 *
 * Windows arrive as a map rather than named fields because spike 0013 also found
 * the binding one is not the obvious one: five-hour read 37% while seven-day read
 * 87% and was the one that warned. The typings name more windows than that run
 * produced, so nothing here enumerates them.
 */
export function accountUsageFrom(payload: ProviderUsagePayload | null): AccountUsage | null {
  if (!payload || payload.rate_limits_available !== true) return null;

  const limits = payload.rate_limits;
  if (!limits || typeof limits !== 'object') return null;

  const windows: Record<string, UsageWindow> = {};
  for (const [name, raw] of Object.entries(limits)) {
    if (!raw || typeof raw !== 'object') continue;
    const window = raw as { utilization?: unknown; resets_at?: unknown };

    if (typeof window.utilization !== 'number' || !Number.isFinite(window.utilization)) continue;
    if (typeof window.resets_at !== 'string') continue;

    const resetsAt = new Date(window.resets_at);
    if (Number.isNaN(resetsAt.getTime())) continue;

    windows[name] = {
      // Clamped as well as divided: a provider reporting above 100 would hand a
      // governor a fraction above one, and every comparison downstream would
      // read as "there is room" or "there is none" by accident.
      utilization: Math.min(1, Math.max(0, window.utilization / 100)),
      resetsAt,
    };
  }

  if (Object.keys(windows).length === 0) return null;

  return {
    subscription: typeof payload.subscription_type === 'string' ? payload.subscription_type : null,
    windows,
  };
}
