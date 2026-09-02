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
import type { Profile } from '@cortana/policy';
import { z } from 'zod';
import { isModelTier, MODEL_TIERS, type ModelRunner } from './port.ts';

export interface ContractCase {
  readonly name: string;
  run(runner: ModelRunner): Promise<void>;
}

/**
 * What the contract's own sessions may do: nothing.
 *
 * Every case here is about talking, so a profile granting a tool would be
 * granting it for no reason — and this file is run against a live provider by
 * hand, on somebody's own machine, which is the worst place for a permission
 * nobody needs.
 *
 * `sandbox: 'none'` rather than `'required'` is the one deliberate looseness,
 * and it is about where this runs rather than what it does. A required sandbox
 * makes the contract fail on a host without one — [spike 0010](../../../docs/spikes/0010-non-bash-containment.md)
 * found `failIfUnavailable` doing exactly that, which is the behaviour it is for
 * — and a contract that cannot run on the machine in front of you is a contract
 * nobody runs. There is nothing to contain: the session has no tools.
 */
const CONTRACT_PROFILE: Profile = {
  name: 'contract',
  trust: 'system',
  tools: [],
  readable: [],
  writable: [],
  denyRead: [],
  network: 'denied',
  sandbox: 'none',
  confirm: 'never',
};

const ANSWER = z.object({
  verdict: z.enum(['yes', 'no']),
  because: z.string().min(1),
});

/**
 * A shape with a list in it, and a field whose honest value is sometimes absent.
 *
 * The flat schema above says nothing about either, and both are what M3's agent
 * actually sends: `{ reply, actions }` where an action's path is null when the
 * call touches no path. Two reasons that is worth a case of its own.
 *
 * The first is precedent. The provider rejected the `$schema` key Zod emits, and
 * nothing found it until this contract was run by hand against the real adapter
 * — a schema feature that every test accepted and the provider did not. A nested
 * array and a union type are the next two features to find out about, and
 * finding out here costs one turn.
 *
 * The second is [ADR-0015](../../../docs/adr/0015-structured-output-at-the-model-boundary.md)'s
 * measured remedy: a field that may legitimately have no value **must permit
 * null**, or the model fills it because it cannot leave it empty. Zod renders
 * that as `type: ["string", "null"]`, which is the spelling the ADR measured
 * working. This case is where that stays true.
 */
const NESTED = z.object({
  summary: z.string().min(1),
  items: z.array(
    z.object({
      name: z.string().min(1),
      /** Null is the right answer when the item has no note, and must be reachable. */
      note: z.string().nullable(),
    }),
  ),
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
          const session = await runner.start({
            tier,
            systemPrompt: 'You are terse.',
            profile: CONTRACT_PROFILE,
          });
          assert.equal(session.tier, tier, `asked for ${tier}`);
          assert.ok(isModelTier(session.tier));
          await session.stop();
        }
      },
    },

    {
      name: 'gives every session its own identity',
      async run(runner) {
        const one = await runner.start({
          tier: 'fast',
          systemPrompt: 'a',
          profile: CONTRACT_PROFILE,
        });
        const two = await runner.start({
          tier: 'fast',
          systemPrompt: 'a',
          profile: CONTRACT_PROFILE,
        });

        assert.notEqual(one.id, two.id, 'two sessions must not share an identity');
        await one.stop();
        await two.stop();
      },
    },

    {
      name: 'keeps a session identity stable across turns',
      async run(runner) {
        const session = await runner.start({
          tier: 'fast',
          systemPrompt: 'Answer briefly.',
          profile: CONTRACT_PROFILE,
        });
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
        const session = await runner.start({
          tier: 'fast',
          systemPrompt: 'Answer briefly.',
          profile: CONTRACT_PROFILE,
        });
        const result = await session.turn('Reply with a single word.');

        assert.equal(typeof result.text, 'string');
        assert.ok(result.text.length > 0, 'a prose turn must produce something');
        await session.stop();
      },
    },

    {
      name: 'reports usage that can be added up and explained',
      async run(runner) {
        const session = await runner.start({
          tier: 'fast',
          systemPrompt: 'Answer briefly.',
          profile: CONTRACT_PROFILE,
        });
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
      name: 'produces values of the shape asked for, with no budget from the caller',
      async run(runner) {
        // ADR-0015: the turn budget must be derived from the model in use, with
        // headroom for the carrier turn. The port gives the caller nowhere to
        // pass one, so an adapter that needed to be told could not pass this.
        const session = await runner.startStructured(
          { tier: 'fast', systemPrompt: 'Answer briefly.', profile: CONTRACT_PROFILE },
          ANSWER,
        );
        const result = await session.turn(
          'Is seven a prime number? Answer with a verdict and a reason.',
        );

        assert.ok(['yes', 'no'].includes(result.value.verdict));
        assert.ok(result.value.because.length > 0);
        await session.stop();
      },
    },

    {
      name: 'gives a session no tool its profile did not name',
      async run(runner) {
        // The most consequential case here, and the one an adapter is most
        // likely to satisfy on paper. On 2026-09-02 a session opened under a
        // profile with no tools called `ToolSearch` and it succeeded, listing
        // eighteen reachable tools; every unit test in the repository passed
        // that day, because they all checked what the adapter computed rather
        // than what the session got.
        //
        // Against the fake this is scripted and cannot fail — the fake has no
        // tools to leak. Against a real provider it is the measurement, and it
        // is here rather than in a spike so that it is re-run every time the
        // provider changes underneath this code.
        const session = await runner.start({
          tier: 'fast',
          systemPrompt: 'Answer with facts about your own configuration. Be exact.',
          profile: CONTRACT_PROFILE,
        });
        const result = await session.turn(
          'Reply with exactly one word and nothing else: NONE if you have no tools ' +
            'available to call, or the exact name of any one tool you do have.',
        );
        await session.stop();

        const said = result.text.trim().toUpperCase();
        assert.ok(
          said.startsWith('NONE'),
          `a profile with no tools left the session holding something: ${result.text.slice(0, 200)}`,
        );
      },
    },

    {
      name: 'produces a nested shape, with an absent value left absent',
      async run(runner) {
        const session = await runner.startStructured(
          {
            tier: 'fast',
            systemPrompt: 'Answer from what you are given and invent nothing.',
            profile: CONTRACT_PROFILE,
          },
          NESTED,
        );
        const result = await session.turn(
          'Two items. "alpha" has the note "first". "beta" has no note at all. ' +
            'Summarise them in one sentence.',
        );

        assert.equal(typeof result.value.summary, 'string');
        assert.equal(result.value.items.length, 2, 'the list survived the crossing');
        for (const item of result.value.items) {
          assert.ok(item.name.length > 0);
          assert.ok(
            item.note === null || typeof item.note === 'string',
            'note is a string or null, and both are already guaranteed by validation',
          );
        }

        // The claim being checked is that null is *reachable*, not that the model
        // is truthful — schema-validity is not truth-validity, which ADR-0015
        // says in as many words. A model that writes a note for beta has told a
        // small lie; a port that cannot represent the absence has a defect. Only
        // the second is this contract's business, and it is asserted rather than
        // hoped for because the ADR measured a non-nullable field being filled
        // precisely because it could not be left empty.
        const beta = result.value.items.find((item) => item.name.toLowerCase().includes('beta'));
        if (beta !== undefined) {
          assert.ok(
            beta.note === null || beta.note.length > 0,
            'an empty string is neither a note nor an absence, and means the union collapsed',
          );
        }

        await session.stop();
      },
    },

    {
      name: 'gives a structured session the same identity and lifecycle as any other',
      async run(runner) {
        // The two kinds differ in what a turn returns and in nothing else. An
        // adapter that implemented them as separate worlds would drift, and the
        // kernel holds both through the same base.
        const session = await runner.startStructured(
          { tier: 'balanced', systemPrompt: 'Answer briefly.', profile: CONTRACT_PROFILE },
          ANSWER,
        );

        assert.equal(session.tier, 'balanced');
        assert.equal(session.stopped, false);
        await session.stop();
        assert.equal(session.stopped, true);
        await session.stop();

        await assert.rejects(
          () => session.turn('anything'),
          (error: unknown) => isAppError(error) && error.category === 'provider',
        );
      },
    },

    {
      name: 'refuses a turn once the session has stopped',
      async run(runner) {
        const session = await runner.start({
          tier: 'fast',
          systemPrompt: 'a',
          profile: CONTRACT_PROFILE,
        });
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
        const session = await runner.start({
          tier: 'fast',
          systemPrompt: 'a',
          profile: CONTRACT_PROFILE,
        });
        await session.stop();
        await session.stop();

        assert.equal(session.stopped, true);
      },
    },

    {
      name: 'reports account usage on one scale, or says it cannot',
      async run(runner) {
        // A session is opened first, and that is not incidental. A provider may
        // expose its account meter only through a live conversation, so asking
        // with nothing open can legitimately answer null — and then every
        // assertion below is skipped. The first hand-run against the real
        // adapter passed this case in 0 ms for exactly that reason, having
        // checked nothing at all. A case that passes by not happening is worse
        // than no case.
        const session = await runner.start({
          tier: 'fast',
          systemPrompt: 'a',
          profile: CONTRACT_PROFILE,
        });
        try {
          const usage = await runner.usage();
          if (usage === null) return; // Still a legitimate answer. See the port.

          assert.ok(usage.subscription === null || typeof usage.subscription === 'string');
          for (const [name, window] of Object.entries(usage.windows)) {
            // Spike 0013 found the provider reporting 87 in one place and 0.87
            // in another, and called a mistake here "a factor of a hundred in a
            // governor's arithmetic". The port fixes the scale; adapters
            // normalise onto it.
            assert.ok(
              window.utilization >= 0 && window.utilization <= 1,
              `${name}: utilization must be a fraction from 0 to 1, got ${window.utilization}`,
            );
            assert.ok(
              window.resetsAt instanceof Date && !Number.isNaN(window.resetsAt.getTime()),
              `${name}: resetsAt must be a real date`,
            );
          }
        } finally {
          await session.stop();
        }
      },
    },
  ];
}
