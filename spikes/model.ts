/**
 * Shared model selection for the spikes.
 *
 * The first round of spikes hard-coded `haiku` to keep them cheap. That was a
 * mistake, and a specific one: a measurement taken on the cheapest model answers
 * a question about the cheapest model, not about the system. It produced one
 * overgeneralised conclusion — that structured output always costs an extra turn
 * — which held on haiku and not on sonnet.
 *
 * So the model is a parameter, and the default is the tier the product is
 * actually expected to run on rather than the one that makes the bill smallest.
 *
 * This file is shared across spikes by relative import, which is safe precisely
 * because it has no dependencies: it is plain TypeScript that Node strips and
 * runs, so it does not tie the spikes' pinned dependency trees together.
 */

export type Tier = 'haiku' | 'sonnet' | 'opus';

export const MODEL = (process.env['MODEL'] ?? 'sonnet') as Tier;

/**
 * Turn budget for a structured-output call, derived from the model.
 *
 * Measured in spike 0005 and recorded in ADR-0015: whether the internal
 * StructuredOutput carrier fits in the same turn as the answer is
 * model-dependent. haiku answers in prose, ends its turn, and needs a second one.
 * sonnet does both at once.
 *
 * A budget tuned for one model therefore breaks silently on another, and the
 * symptom — error_max_turns — names nothing about the cause. Deriving it is the
 * whole point; the `+1` is headroom, not superstition.
 */
export function structuredTurnBudget(model: Tier = MODEL): number {
  return model === 'haiku' ? 3 : 2;
}

/** Formats the per-model token breakdown a result message carries. */
export function formatUsage(modelUsage: unknown): string[] {
  if (!modelUsage || typeof modelUsage !== 'object') return ['  usage           (not reported)'];
  const lines: string[] = [];
  for (const [name, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
    const u = raw as Record<string, number | undefined>;
    const parts = [
      `in ${u['inputTokens'] ?? u['input_tokens'] ?? '?'}`,
      `out ${u['outputTokens'] ?? u['output_tokens'] ?? '?'}`,
      `cacheRead ${u['cacheReadInputTokens'] ?? u['cache_read_input_tokens'] ?? 0}`,
      `cacheWrite ${u['cacheCreationInputTokens'] ?? u['cache_creation_input_tokens'] ?? 0}`,
    ];
    lines.push(`  ${name.padEnd(30)} ${parts.join('  ')}`);
  }
  return lines;
}

/**
 * A spend ceiling per query, sized so it stops a runaway loop without aborting a
 * legitimate first turn.
 *
 * This has to be model-aware because of prompt caching. A cold-cache turn writes
 * the whole system context — measured at ~83,000 tokens even with no tools and no
 * setting sources — and on sonnet that first turn cost $0.50 against $0.027 for
 * the same call once warm. A cap of $0.50 therefore looks generous and aborts the
 * very first call with `error_max_budget_usd`, which is exactly what happened
 * before this was measured.
 *
 * The lesson generalises past the spikes: `maxBudgetUsd` is not a per-turn
 * throttle, because the first turn after a cache miss is an order of magnitude
 * more expensive than the steady state.
 */
export function budgetCeilingUsd(model: Tier = MODEL): number {
  const ceilings: Record<Tier, number> = { haiku: 1, sonnet: 3, opus: 10 };
  return Number(process.env['BUDGET_USD'] ?? ceilings[model]);
}

/**
 * Printed before any run that spends money. The numbers are measured, and the
 * spread between them is the point: cost is dominated by whether the prompt
 * cache is warm, not by the size of the prompt.
 */
export function costWarning(turns: number): string {
  const each: Record<Tier, string> = {
    haiku: 'first turn ~$0.12, then ~$0.01',
    sonnet: 'first turn ~$0.50, then ~$0.027',
    opus: 'unmeasured — expect several times sonnet',
  };
  return [
    `  ⚠  ${turns} model turn(s) on ${MODEL}: ${each[MODEL]}.`,
    '     The first turn writes ~83k tokens of system context to the prompt cache;',
    '     later turns read it back. That is where the spread comes from.',
  ].join('\n');
}
