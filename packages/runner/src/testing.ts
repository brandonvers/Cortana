/**
 * The second adapter.
 *
 * It sits under `testing` because that is where it is used, but it is not a test
 * double in the sense `@cortana/core/testing`'s manual clock is. ADR-0001 says a
 * second adapter is expected "for deterministic tests if nothing else", and that
 * contract tests "make the port real rather than aspirational" — which is a claim
 * about the **port's design**, not about coverage. A port with one implementation
 * is a description of that implementation wearing an interface.
 *
 * It is written before the provider adapter, and the provider adapter is built to
 * pass tests that already exist. A port designed after its only implementation
 * inherits every assumption that implementation made.
 *
 * It also does the real validation. Handing back a scripted value unchecked would
 * make it pass a contract the other adapter has to earn.
 */

import { AppError, newSessionId } from '@cortana/core';
import type { Profile } from '@cortana/policy';
import type { ZodType } from 'zod';
import type {
  AccountUsage,
  ModelRunner,
  ModelSession,
  SessionSpec,
  StructuredSession,
  StructuredTurnResult,
  TurnImage,
  TurnResult,
  TurnUsage,
} from './port.ts';

/**
 * A profile for tests that are not about profiles.
 *
 * `SessionSpec.profile` is required, which means every test that opens a session
 * now has to say something about containment even when containment is not what
 * it is testing. Without a shared constant each of those tests would invent its
 * own, they would drift, and one of them would eventually be permissive in a way
 * nobody meant.
 *
 * It lives in the testing entry point rather than in `@cortana/policy` for the
 * same reason the manual clock does: a permissive profile shipped from the
 * policy package is a permissive profile that production code can reach for
 * without anyone noticing. Importing it here has to be spelled out.
 *
 * It grants nothing. A test that needs a tool says so itself, so what a test
 * session may do is visible in the test rather than inherited from here.
 */
export const TEST_PROFILE: Profile = {
  name: 'test',
  trust: 'system',
  tools: [],
  readable: [],
  writable: [],
  denyRead: [],
  network: 'denied',
  sandbox: 'none',
  confirm: 'never',
};

export interface RecordedTurn {
  readonly session: string;
  readonly prompt: string;
  readonly structured: boolean;
  /** What was handed to the turn beside its text. Empty for a text-only turn. */
  readonly images: readonly TurnImage[];
}

export interface FakeScript {
  /** Answers for prose turns, in order. The last one repeats once exhausted. */
  readonly text?: readonly string[];
  /**
   * Answers for structured turns, in order, **before** validation.
   *
   * Scripting a value the schema rejects is how the "never coerced" behaviour is
   * exercised: there is no flag for it, because a fake with a "misbehave" switch
   * tests the switch rather than the path.
   */
  readonly values?: readonly unknown[];
  readonly usage?: Partial<TurnUsage>;
  /** `null` models an adapter that cannot report account usage. */
  readonly accountUsage?: AccountUsage | null;
}

export interface FakeRunner extends ModelRunner {
  /** Every turn asked of it, in order. */
  readonly turns: readonly RecordedTurn[];
  readonly sessions: number;
  /**
   * Every spec a session was opened with, in order.
   *
   * Here so that a caller which builds a spec — the agent does — can be checked
   * on what it actually asked for. A profile that is computed correctly and then
   * not passed on looks identical from outside, and that is the failure this
   * repository has now found four times in checks that passed for the wrong
   * reason.
   */
  readonly opened: readonly SessionSpec[];
}

const DEFAULT_USAGE: TurnUsage = {
  inputTokens: 12,
  outputTokens: 34,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.0001,
};

export function fakeRunner(script: FakeScript = {}): FakeRunner {
  const turns: RecordedTurn[] = [];
  const opened: SessionSpec[] = [];
  let sessions = 0;
  let textIndex = 0;
  let valueIndex = 0;

  const usage: TurnUsage = { ...DEFAULT_USAGE, ...script.usage };

  const nextText = (): string => {
    const answers = script.text ?? ['ok'];
    const answer = answers[Math.min(textIndex, answers.length - 1)] ?? 'ok';
    textIndex += 1;
    return answer;
  };

  const nextValue = (prompt: string): unknown => {
    const values = script.values ?? [];
    if (valueIndex >= values.length) {
      throw new AppError(
        'the fake runner was asked for a structured turn with nothing left scripted for it',
        {
          category: 'internal',
          code: 'fake-runner-unscripted',
          detail: { prompt: prompt.slice(0, 80), asked: valueIndex + 1, scripted: values.length },
        },
      );
    }
    const value = values[valueIndex];
    valueIndex += 1;
    return value;
  };

  /**
   * Everything both kinds of session share, so neither can drift from the other.
   *
   * The two sessions below delegate to this through explicit getters rather than
   * spreading it. Spreading looks tidier and is wrong: `{ ...base }` evaluates
   * `stopped` once and copies the value, so `stop()` would set a variable the
   * returned session no longer reads. The contract caught it, which is the
   * clearest argument for the contract there has been.
   */
  const openSession = (spec: SessionSpec) => {
    sessions += 1;
    opened.push(spec);
    const id = newSessionId();
    let stopped = false;

    return {
      id,
      tier: spec.tier,
      get stopped(): boolean {
        return stopped;
      },
      async stop(): Promise<void> {
        stopped = true;
      },
      refuseIfStopped(): void {
        if (!stopped) return;
        throw new AppError('this session has stopped and will not take another turn', {
          category: 'provider',
          code: 'session-stopped',
          detail: { session: id },
        });
      },
    };
  };

  return {
    name: 'fake',
    get turns() {
      return turns;
    },
    get sessions() {
      return sessions;
    },
    get opened() {
      return opened;
    },

    async start(spec: SessionSpec): Promise<ModelSession> {
      const base = openSession(spec);
      return {
        id: base.id,
        tier: base.tier,
        get stopped(): boolean {
          return base.stopped;
        },
        stop: () => base.stop(),
        async turn(prompt: string, images: readonly TurnImage[] = []): Promise<TurnResult> {
          base.refuseIfStopped();
          turns.push({ session: base.id, prompt, structured: false, images });
          return { text: nextText(), usage };
        },
      };
    },

    async startStructured<Value>(
      spec: SessionSpec,
      schema: ZodType<Value>,
    ): Promise<StructuredSession<Value>> {
      const base = openSession(spec);
      return {
        id: base.id,
        tier: base.tier,
        get stopped(): boolean {
          return base.stopped;
        },
        stop: () => base.stop(),
        async turn(
          prompt: string,
          images: readonly TurnImage[] = [],
        ): Promise<StructuredTurnResult<Value>> {
          base.refuseIfStopped();
          turns.push({ session: base.id, prompt, structured: true, images });

          const parsed = schema.safeParse(nextValue(prompt));
          if (!parsed.success) {
            // ADR-0015: a response that fails validation is a handled error
            // path, never coerced into looking valid. The rejected value is
            // deliberately absent from the detail — it is whatever the model
            // said, which may be whatever the operator typed.
            throw new AppError('the model returned a value the schema rejected', {
              category: 'provider',
              code: 'structured-output-invalid',
              detail: { session: base.id, issues: parsed.error.issues.length },
              cause: parsed.error,
            });
          }

          return { text: '', value: parsed.data, usage };
        },
      };
    },

    async usage(): Promise<AccountUsage | null> {
      return script.accountUsage ?? null;
    },
  };
}
