import { isAppError } from '@cortana/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isRateLimitWarning, rateLimitStateFrom } from './adapter.ts';
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

describe('the rate-limit warning the provider pushes', () => {
  // Spike 0013 called this the best result of that run: the provider says when
  // the account crosses a threshold, which window, and when it resets — so a
  // governor need not poll or invent thresholds of its own. The adapter read
  // these events off the stream and discarded them until that was noticed.
  const event = {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning',
      rateLimitType: 'seven_day',
      utilization: 0.87,
      surpassedThreshold: 0.75,
      resetsAt: 1_787_065_200,
      isUsingOverage: false,
    },
  };

  it('carries the window, the threshold, and when it resets', () => {
    const warning = rateLimitStateFrom(event);

    expect(warning?.status).toBe('allowed_warning');
    expect(warning?.window).toBe('seven_day');
    expect(warning?.surpassedThreshold).toBe(0.75);
    // Cross-checks against spike 0013, which recorded the same account's
    // seven-day window resetting at 2026-08-18T14:59:59 and the pushed event
    // carrying resetsAt: 1787065200. Two representations of one instant, and
    // this is the conversion between them.
    expect(warning?.resetsAt?.toISOString()).toBe('2026-08-18T15:00:00.000Z');
  });

  it('passes the utilization through rather than dividing it', () => {
    // The trap this comment exists to prevent. The usage endpoint reports 87 and
    // must be divided; this event reports 0.87 and must not be. Dividing here
    // would be the factor of a hundred spike 0013 warned about, applied in the
    // one place it does not belong.
    expect(rateLimitStateFrom(event)?.utilization).toBe(0.87);
  });

  it('ignores messages that are not rate-limit events', () => {
    expect(rateLimitStateFrom({ type: 'result', subtype: 'success' })).toBeNull();
    expect(rateLimitStateFrom({ type: 'rate_limit_event' })).toBeNull();
  });

  it('refuses a status it does not recognise rather than passing it on', () => {
    // A status this code has never seen is a signal it cannot interpret, and
    // forwarding it would let a governor act on a word nobody has defined.
    expect(
      rateLimitStateFrom({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'something_new_in_a_later_release' },
      }),
    ).toBeNull();
  });

  it('tolerates a warning that says less than the full shape', () => {
    const sparse = rateLimitStateFrom({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected' },
    });

    expect(sparse?.status).toBe('rejected');
    expect(sparse?.window).toBeNull();
    expect(sparse?.resetsAt).toBeNull();
  });
});

describe('telling headroom from a warning', () => {
  const state = (status: string, extra: Record<string, unknown> = {}) =>
    rateLimitStateFrom({ type: 'rate_limit_event', rate_limit_info: { status, ...extra } });

  it('does not call an ordinary allowed state a warning', () => {
    // The first live observation on the deployment target was exactly this:
    // five_hour, status allowed, and no utilization attached at all. Treating it
    // as a warning mislabels it for anything reading the stream, and a governor
    // acting on it would be acting on nothing.
    const allowed = state('allowed', { rateLimitType: 'five_hour' });

    expect(allowed?.window).toBe('five_hour');
    expect(allowed?.utilization).toBeNull();
    expect(allowed && isRateLimitWarning(allowed)).toBe(false);
  });

  it('calls the two that mean something warnings', () => {
    for (const status of ['allowed_warning', 'rejected']) {
      const it = state(status);
      expect(it && isRateLimitWarning(it)).toBe(true);
    }
  });
});

describe('a failure the provider explained', () => {
  it('leads with what the provider said', () => {
    // Measured on 2026-09-05, running a turn with no credentials:
    // { subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }.
    // A failure sets is_error and leaves subtype at "success", so a message built
    // from the subtype alone reads "the provider ended the turn with success" —
    // not an explanation, and it discards the one string an operator can act on.
    const failure = failureFrom({
      subtype: 'success',
      is_error: true,
      result: 'Not logged in · Please run /login',
    });

    expect(failure?.message).toMatch(/^Not logged in/);
    expect(failure?.message).toContain('Please run /login');
  });

  it('keeps the subtype for whoever matches on it', () => {
    const failure = failureFrom({ subtype: 'error_max_turns', is_error: true, result: 'gave up' });

    expect(failure?.detail?.['subtype']).toBe('error_max_turns');
    // And the mapped explanation is an addition to the provider's words rather
    // than a replacement for them.
    expect(failure?.message).toContain('gave up');
    expect(failure?.message).toContain('ran out of turns');
  });

  it('still says something when the provider said nothing', () => {
    const failure = failureFrom({ subtype: 'error_max_budget_usd', is_error: true });

    expect(failure?.message).toContain('error_max_budget_usd');
    expect(failure?.message).toContain('cost ceiling');
  });

  it('bounds what it repeats, since the text reaches a log and an audit row', () => {
    const failure = failureFrom({ subtype: 'success', is_error: true, result: 'x'.repeat(5_000) });

    expect(failure?.message.length).toBeLessThan(700);
  });

  it('is still null for a turn that actually succeeded', () => {
    expect(failureFrom({ subtype: 'success', is_error: false, result: 'fine' })).toBeNull();
  });
});
