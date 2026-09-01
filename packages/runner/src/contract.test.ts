import { isAppError } from '@cortana/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { modelRunnerContract } from './contract.ts';
import { fakeRunner } from './testing.ts';

/**
 * The contract, against the second adapter.
 *
 * When `runner-claude` arrives it gets a file that looks exactly like the loop
 * below and nothing else. Any case that has to be relaxed for the real adapter
 * is a finding about the port, and is recorded as one rather than accommodated.
 */
describe('the ModelRunner contract, against the fake', () => {
  for (const contractCase of modelRunnerContract()) {
    it(contractCase.name, async () => {
      // Configured so that every case actually executes. The usage case returns
      // early when an adapter reports null — which is a legitimate answer and
      // exactly why a fake reporting null would let the scale assertion never
      // run at all. A contract case that passes by not happening is worse than
      // no case.
      await contractCase.run(
        fakeRunner({
          values: [
            { verdict: 'yes', because: 'it has no divisors but one and itself' },
            { verdict: 'no', because: 'the second structured case needs one too' },
          ],
          accountUsage: {
            subscription: 'pro',
            windows: {
              five_hour: { utilization: 0.37, resetsAt: new Date('2026-09-01T12:00:00Z') },
              seven_day: { utilization: 0.87, resetsAt: new Date('2026-09-03T12:00:00Z') },
            },
          },
        }),
      );
    });
  }

  it('is not empty, and would say so', () => {
    // A contract suite that silently became a loop over nothing would pass
    // against every adapter including a broken one.
    expect(modelRunnerContract().length).toBeGreaterThanOrEqual(10);
  });
});

describe('what the contract cannot cover, covered here', () => {
  const ANSWER = z.object({ verdict: z.enum(['yes', 'no']), because: z.string().min(1) });

  it('raises rather than coercing when the value fails its schema', async () => {
    // ADR-0015: "A response that fails validation is a handled error path, not
    // an exception: retried, escalated, or recorded as a failed turn. It is
    // never coerced into looking valid." Only a scripted adapter can be made to
    // return nonsense on demand, which is why this is here and not in the
    // contract.
    const runner = fakeRunner({ values: [{ verdict: 'maybe', because: '' }] });
    const session = await runner.startStructured({ tier: 'fast', systemPrompt: 'a' }, ANSWER);

    // One call, one scripted value. Asking twice would consume the script and
    // then fail for the entirely different reason that nothing was left.
    const caught = await session.turn('anything').then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(caught.ok).toBe(false);
    if (caught.ok) return;
    expect((caught.error as Error).message).toMatch(/schema rejected/);
    expect(isAppError(caught.error) && caught.error.category).toBe('provider');
    expect(isAppError(caught.error) && caught.error.code).toBe('structured-output-invalid');
  });

  it('does not leak the rejected value into the error', async () => {
    // A prompt or a response can contain anything the operator typed. An error
    // that quotes it puts that in a log line, which ADR-0018 spends a type
    // preventing everywhere else.
    const secretish = 'sk-live-not-a-verdict';
    const runner = fakeRunner({ values: [{ verdict: secretish, because: 'x' }] });
    const session = await runner.startStructured({ tier: 'fast', systemPrompt: 'a' }, ANSWER);

    try {
      await session.turn('anything');
    } catch (error) {
      expect(JSON.stringify(isAppError(error) ? error.detail : {})).not.toContain(secretish);
      expect((error as Error).message).not.toContain(secretish);
    }
  });

  it('says plainly when the fake has nothing scripted, rather than inventing a value', async () => {
    // A fake that made up a value satisfying any schema would let a test pass
    // without anyone deciding what the model was supposed to say.
    const runner = fakeRunner();
    const session = await runner.startStructured({ tier: 'fast', systemPrompt: 'a' }, ANSWER);

    await expect(session.turn('anything')).rejects.toThrow(/nothing left scripted/);
  });
});

describe('the fake as a fake', () => {
  it('records what it was asked, in order', async () => {
    const runner = fakeRunner({ text: ['first', 'second'] });
    const session = await runner.start({ tier: 'balanced', systemPrompt: 'a' });

    expect((await session.turn('one')).text).toBe('first');
    expect((await session.turn('two')).text).toBe('second');
    expect((await session.turn('three')).text).toBe('second');

    expect(runner.turns.map((t) => t.prompt)).toEqual(['one', 'two', 'three']);
    expect(runner.sessions).toBe(1);
  });

  it('can report account usage, on the port’s scale', async () => {
    const runner = fakeRunner({
      accountUsage: {
        subscription: 'pro',
        windows: {
          five_hour: { utilization: 0.37, resetsAt: new Date('2026-09-01T12:00:00Z') },
          seven_day: { utilization: 0.87, resetsAt: new Date('2026-09-03T12:00:00Z') },
        },
      },
    });

    const usage = await runner.usage();
    expect(usage?.windows['seven_day']?.utilization).toBe(0.87);
  });

  it('reports nothing by default, because that is a normal answer', async () => {
    expect(await fakeRunner().usage()).toBeNull();
  });
});
