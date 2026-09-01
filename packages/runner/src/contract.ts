/**
 * What every adapter must do, expressed once.
 *
 * This is the mechanism that makes the port a port. ADR-0001 expects "contract
 * tests against recorded fixtures" so that a second adapter is a real
 * possibility rather than a promise, and the only way that claim can be checked
 * is by running the same tests against more than one implementation.
 *
 * ## Why it uses `node:assert` and returns cases instead of calling `it()`
 *
 * Two reasons, and the second is the one that mattered.
 *
 * A contract that imported a test framework would put that framework in the
 * dependency graph of the port itself, which is meant to depend on nothing but
 * `core` and a schema library.
 *
 * And the M2 plan decided that **runs against the real adapter are started by
 * hand** — CI has no provider credential and is not getting one, and spike 0009
 * measured an identical call costing $0.0201 and $0.6891, so a suite that called
 * out on every pull request would have a bill scaling with the test count. A
 * contract that is a list of plain functions can be run from a script against a
 * live adapter, on a person's own machine, when they choose. One that is a
 * `describe` block can only be run by the test runner.
 *
 * ## What it deliberately does not cover
 *
 * **Behaviour on a malformed response.** ADR-0015 requires that a value failing
 * validation is a handled error rather than something coerced, and that cannot
 * be checked uniformly: a fake can be scripted to return nonsense, and a real
 * provider cannot be made to on demand. It is tested against the fake, in the
 * fake's own tests, and this is the record of why it is not here.
 *
 * **That structured output costs no extra turns.** The port has nowhere for a
 * caller to pass a turn budget, which is the design ADR-0015 asks for — so the
 * case below establishes that an adapter arranges the mechanism itself, not that
 * it does so cheaply. What it costs is the adapter's business and the audit's to
 * record.
 */

import assert from 'node:assert/strict';
import { isAppError } from '@cortana/core';
import { z } from 'zod';
import { isModelTier, MODEL_TIERS, type ModelRunner } from './port.ts';

export interface ContractCase {
  readonly name: string;
  run(runner: ModelRunner): Promise<void>;
}

const ANSWER = z.object({
  verdict: z.enum(['yes', 'no']),
  because: z.string().min(1),
});

/**
 * The cases, in the order a reader should meet them.
 *
 * Each takes a fresh runner. An adapter that only works once is not an adapter.
 */
export function modelRunnerContract(): readonly ContractCase[] {
  return [
    {
      name: 'names itself, so a turn can be attributed to the adapter that ran it',
      async run(runner) {
        assert.equal(typeof runner.name, 'string');
        assert.ok(runner.name.length > 0, 'an adapter must have a name');
      },
    },

    {
      name: 'starts a session at the tier it was asked for',
      async run(runner) {
        for (const tier of MODEL_TIERS) {
          const session = await runner.start({ tier, systemPrompt: 'You are terse.' });
          assert.equal(session.tier, tier, `asked for ${tier}`);
          assert.ok(isModelTier(session.tier));
          await session.stop();
        }
      },
    },

    {
      name: 'gives every session its own identity',
      async run(runner) {
        const one = await runner.start({ tier: 'fast', systemPrompt: 'a' });
        const two = await runner.start({ tier: 'fast', systemPrompt: 'a' });

        assert.notEqual(one.id, two.id, 'two sessions must not share an identity');
        await one.stop();
        await two.stop();
      },
    },

    {
      name: 'keeps a session identity stable across turns',
      async run(runner) {
        const session = await runner.start({ tier: 'fast', systemPrompt: 'Answer briefly.' });
        const before = session.id;
        await session.turn('Say hello.');
        await session.turn('Say hello again.');

        assert.equal(session.id, before, 'the identity is the session, not the turn');
        await session.stop();
      },
    },

    {
      name: 'answers a prose turn with text',
      async run(runner) {
        const session = await runner.start({ tier: 'fast', systemPrompt: 'Answer briefly.' });
        const result = await session.turn('Reply with a single word.');

        assert.equal(typeof result.text, 'string');
        assert.ok(result.text.length > 0, 'a prose turn must produce something');
        await session.stop();
      },
    },

    {
      name: 'reports usage that can be added up and explained',
      async run(runner) {
        const session = await runner.start({ tier: 'fast', systemPrompt: 'Answer briefly.' });
        const { usage } = await session.turn('Reply with a single word.');

        for (const [field, value] of Object.entries({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        })) {
          assert.equal(typeof value, 'number', `${field} must be a number`);
          assert.ok(Number.isFinite(value) && value >= 0, `${field} must be finite and >= 0`);
        }
        // The cache counters are why a cost is interpretable at all: spike 0009
        // measured a 34× spread on cache state alone. A cost without them is a
        // number nobody can act on.
        assert.ok(
          usage.costUsd === null || (typeof usage.costUsd === 'number' && usage.costUsd >= 0),
          'cost is a non-negative number or null, and null is a normal answer',
        );
        await session.stop();
      },
    },

    {
      name: 'produces a value of the shape asked for, with no budget from the caller',
      async run(runner) {
        // ADR-0015: the turn budget must be derived from the model in use, with
        // headroom for the carrier turn. The port gives the caller nowhere to
        // pass one, so an adapter that needed to be told could not pass this.
        const session = await runner.start({ tier: 'fast', systemPrompt: 'Answer briefly.' });
        const result = await session.turnStructured(
          'Is seven a prime number? Answer with a verdict and a reason.',
          ANSWER,
        );

        assert.ok(['yes', 'no'].includes(result.value.verdict));
        assert.ok(result.value.because.length > 0);
        await session.stop();
      },
    },

    {
      name: 'refuses a turn once the session has stopped',
      async run(runner) {
        const session = await runner.start({ tier: 'fast', systemPrompt: 'a' });
        await session.stop();

        assert.equal(session.stopped, true);
        await assert.rejects(
          () => session.turn('anything'),
          (error: unknown) => isAppError(error) && error.category === 'provider',
          'a stopped session refuses rather than restarting itself',
        );
      },
    },

    {
      name: 'lets a session be stopped twice',
      async run(runner) {
        // Shutdown is reached from a signal handler, and a stop that throws the
        // second time turns a tidy exit into an error nobody caused.
        const session = await runner.start({ tier: 'fast', systemPrompt: 'a' });
        await session.stop();
        await session.stop();

        assert.equal(session.stopped, true);
      },
    },

    {
      name: 'reports account usage on one scale, or says it cannot',
      async run(runner) {
        const usage = await runner.usage();
        if (usage === null) return; // A normal answer. See the port's note.

        assert.ok(usage.subscription === null || typeof usage.subscription === 'string');
        for (const [name, window] of Object.entries(usage.windows)) {
          // Spike 0013 found the provider reporting 87 in one place and 0.87 in
          // another, and called a mistake here "a factor of a hundred in a
          // governor's arithmetic". The port fixes the scale; adapters normalise.
          assert.ok(
            window.utilization >= 0 && window.utilization <= 1,
            `${name}: utilization must be a fraction from 0 to 1, got ${window.utilization}`,
          );
          assert.ok(
            window.resetsAt instanceof Date && !Number.isNaN(window.resetsAt.getTime()),
            `${name}: resetsAt must be a real date`,
          );
        }
      },
    },
  ];
}
