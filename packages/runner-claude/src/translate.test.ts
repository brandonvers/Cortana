import { isAppError } from '@cortana/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  accountUsageFrom,
  DEFAULT_MODELS,
  failureFrom,
  jsonSchemaFor,
  totalCostFrom,
  usageFrom,
} from './translate.ts';

describe('usage', () => {
  const result = {
    subtype: 'success',
    total_cost_usd: 0.25,
    usage: {
      input_tokens: 1_100,
      output_tokens: 340,
      cache_read_input_tokens: 107_000,
      cache_creation_input_tokens: 0,
    },
  };

  it('makes a per-turn cost out of a cumulative one', () => {
    // The SDK's typings are explicit: in a streaming-input session
    // total_cost_usd is "the running total so far", so the per-turn figure is a
    // difference. Reading it directly would report the whole session's cost
    // against every turn, and the number would look entirely plausible.
    expect(usageFrom(result, 0.2).costUsd).toBeCloseTo(0.05, 10);
    expect(usageFrom(result, 0).costUsd).toBeCloseTo(0.25, 10);
  });

  it('reports zero rather than a refund when the total goes backwards', () => {
    // The typings say a resumed session starts fresh and a mid-session clear
    // resets the running total, so the difference really can be negative.
    expect(usageFrom(result, 1.0).costUsd).toBe(0);
  });

  it('says null when the provider reported no cost at all', () => {
    expect(usageFrom({ subtype: 'success', usage: {} }, 0).costUsd).toBeNull();
  });

  it('takes token counts from the per-turn field, by the provider’s names', () => {
    const usage = usageFrom(result, 0.2);

    expect(usage.inputTokens).toBe(1_100);
    expect(usage.outputTokens).toBe(340);
    expect(usage.cacheReadTokens).toBe(107_000);
    expect(usage.cacheWriteTokens).toBe(0);
  });

  it('treats anything that is not a count as zero', () => {
    const usage = usageFrom(
      { usage: { input_tokens: 'lots', output_tokens: -5, cache_read_input_tokens: null } },
      0,
    );

    expect([usage.inputTokens, usage.outputTokens, usage.cacheReadTokens]).toEqual([0, 0, 0]);
  });
});

describe('carrying the running total forward', () => {
  it('advances when the provider reports a larger total', () => {
    expect(totalCostFrom({ total_cost_usd: 0.4 }, 0.25)).toBe(0.4);
  });

  it('keeps the previous total when the provider reports a smaller one', () => {
    // Otherwise the next turn's difference would be inflated by the reset.
    expect(totalCostFrom({ total_cost_usd: 0 }, 0.25)).toBe(0.25);
  });

  it('keeps the previous total when the provider reports none', () => {
    expect(totalCostFrom({}, 0.25)).toBe(0.25);
  });
});

describe('failures', () => {
  it('is silent about a successful turn', () => {
    expect(failureFrom({ subtype: 'success', is_error: false })).toBeNull();
  });

  it('names both causes of running out of turns, because they look identical', () => {
    // ADR-0015 spent a section on this: a budget too small for the carrier turn
    // and a prompt vague enough to draw a clarifying question produce the same
    // symptom, and the symptom names neither. Whoever reads the message will
    // not have the ADR open.
    const error = failureFrom({ subtype: 'error_max_turns', is_error: true, num_turns: 2 });

    expect(isAppError(error) && error.category).toBe('provider');
    expect(error?.message).toMatch(/carrier turn/);
    expect(error?.message).toMatch(/vague/);
    expect(isAppError(error) && error.detail['turns']).toBe(2);
  });

  it('reports a subtype it has never seen without pretending to explain it', () => {
    const error = failureFrom({ subtype: 'error_from_a_later_release', is_error: true });

    expect(error?.message).toContain('error_from_a_later_release');
    expect(error?.message).not.toContain('—');
  });

  it('treats is_error as a failure even when the subtype looks fine', () => {
    expect(failureFrom({ subtype: 'success', is_error: true })).not.toBeNull();
  });
});

describe('account usage', () => {
  const payload = {
    rate_limits_available: true,
    subscription_type: 'pro',
    rate_limits: {
      five_hour: { utilization: 37, resets_at: '2026-09-01T13:59:59.793067+00:00' },
      seven_day: { utilization: 87, resets_at: '2026-09-03T14:59:59.793087+00:00' },
    },
  };

  it('divides the hundred out, once', () => {
    // Spike 0013: the endpoint gives 87 and the pushed event gives 0.87, and a
    // mistake here is "a factor of a hundred in a governor's arithmetic".
    const usage = accountUsageFrom(payload);

    expect(usage?.windows['five_hour']?.utilization).toBeCloseTo(0.37, 10);
    expect(usage?.windows['seven_day']?.utilization).toBeCloseTo(0.87, 10);
  });

  it('keeps every window rather than the two anyone expects', () => {
    // Also spike 0013: the binding window was the seven-day one while the
    // five-hour read comfortable, and the typings name more windows than that
    // run produced.
    const usage = accountUsageFrom({
      ...payload,
      rate_limits: {
        ...payload.rate_limits,
        seven_day_opus: { utilization: 12, resets_at: payload.rate_limits.seven_day.resets_at },
      },
    });

    expect(Object.keys(usage?.windows ?? {}).sort()).toEqual([
      'five_hour',
      'seven_day',
      'seven_day_opus',
    ]);
  });

  it('carries the subscription and a real date', () => {
    const usage = accountUsageFrom(payload);

    expect(usage?.subscription).toBe('pro');
    expect(usage?.windows['seven_day']?.resetsAt.toISOString()).toBe('2026-09-03T14:59:59.793Z');
  });

  it('says nothing when the account has no plan limits', () => {
    // rate_limits_available is false for API key, Bedrock and Vertex sessions.
    expect(accountUsageFrom({ rate_limits_available: false, rate_limits: null })).toBeNull();
    expect(accountUsageFrom(null)).toBeNull();
  });

  it('will not hand a governor a fraction above one', () => {
    const usage = accountUsageFrom({
      rate_limits_available: true,
      rate_limits: {
        odd: { utilization: 140, resets_at: payload.rate_limits.seven_day.resets_at },
      },
    });

    expect(usage?.windows['odd']?.utilization).toBe(1);
  });

  it('skips a window it cannot read instead of inventing one', () => {
    const usage = accountUsageFrom({
      rate_limits_available: true,
      rate_limits: {
        good: { utilization: 50, resets_at: payload.rate_limits.seven_day.resets_at },
        no_reset: { utilization: 50 },
        bad_date: { utilization: 50, resets_at: 'whenever' },
        no_number: { utilization: 'high', resets_at: payload.rate_limits.seven_day.resets_at },
      },
    });

    expect(Object.keys(usage?.windows ?? {})).toEqual(['good']);
  });

  it('says nothing when no window survived', () => {
    expect(
      accountUsageFrom({ rate_limits_available: true, rate_limits: { bad: { utilization: 'x' } } }),
    ).toBeNull();
  });
});

describe('tiers', () => {
  it('maps every tier the port defines', () => {
    expect(Object.keys(DEFAULT_MODELS).sort()).toEqual(['balanced', 'deep', 'fast']);
  });

  it('uses aliases rather than dated snapshots', () => {
    // So the framework follows the provider's current model for a tier. The
    // cost, which ADR-0015 already recorded, is that the alias resolves to
    // something that changes underneath us — which is why the audit records the
    // tier a turn ran at.
    for (const model of Object.values(DEFAULT_MODELS)) {
      expect(model).not.toMatch(/\d{8}/);
    }
  });
});

describe('the JSON schema handed to the provider', () => {
  const ANSWER = z.object({
    verdict: z.enum(['yes', 'no']),
    source: z.union([z.string(), z.null()]),
  });

  it('carries no dialect pointer, because the provider rejects the one Zod emits', () => {
    // Found by running the contract against the real provider, which failed with:
    //   --json-schema is not a valid JSON Schema: no schema with key or ref
    //   "https://json-schema.org/draft/2020-12/schema"
    // Nothing was wrong with the schema; the validator on the other side has no
    // meta-schema registered under that URL, so a pointer to it is fatal.
    expect(z.toJSONSchema(ANSWER)).toHaveProperty('$schema');
    expect(jsonSchemaFor(ANSWER)).not.toHaveProperty('$schema');
  });

  it('keeps a nullable field representable as a null', () => {
    // The reason the dialect stays 2020-12 rather than switching to the target
    // that omits $schema by itself. Spike 0009 measured that making absence
    // representable is what stops a model inventing a value for a field it has
    // nothing to put in, and openapi-3.0 renders the same field as a nested
    // anyOf with an enum of null.
    expect(jsonSchemaFor(ANSWER)['properties']).toMatchObject({
      source: { type: ['string', 'null'] },
    });
  });

  it('still closes the object, so a model cannot add fields nobody asked for', () => {
    expect(jsonSchemaFor(ANSWER)['additionalProperties']).toBe(false);
    expect(jsonSchemaFor(ANSWER)['required']).toEqual(['verdict', 'source']);
  });
});
