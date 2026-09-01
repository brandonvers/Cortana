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
import type { ZodType } from 'zod';
import type {
  AccountUsage,
  ModelRunner,
  ModelSession,
  SessionSpec,
  StructuredTurnResult,
  TurnResult,
  TurnUsage,
} from './port.ts';

export interface RecordedTurn {
  readonly session: string;
  readonly prompt: string;
  readonly structured: boolean;
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

  return {
    name: 'fake',
    get turns() {
      return turns;
    },
    get sessions() {
      return sessions;
    },

    async start(spec: SessionSpec): Promise<ModelSession> {
      sessions += 1;
      const id = newSessionId();
      let stopped = false;

      const refuseIfStopped = (): void => {
        if (!stopped) return;
        throw new AppError('this session has stopped and will not take another turn', {
          category: 'provider',
          code: 'session-stopped',
          detail: { session: id },
        });
      };

      return {
        id,
        tier: spec.tier,
        get stopped() {
          return stopped;
        },

        async turn(prompt: string): Promise<TurnResult> {
          refuseIfStopped();
          turns.push({ session: id, prompt, structured: false });
          return { text: nextText(), usage };
        },

        async turnStructured<Value>(
          prompt: string,
          schema: ZodType<Value>,
        ): Promise<StructuredTurnResult<Value>> {
          refuseIfStopped();
          turns.push({ session: id, prompt, structured: true });

          const parsed = schema.safeParse(nextValue(prompt));
          if (!parsed.success) {
            // ADR-0015: a response that fails validation is a handled error
            // path, never coerced into looking valid.
            throw new AppError('the model returned a value the schema rejected', {
              category: 'provider',
              code: 'structured-output-invalid',
              detail: { session: id, issues: parsed.error.issues.length },
              cause: parsed.error,
            });
          }

          return { text: '', value: parsed.data, usage };
        },

        async stop(): Promise<void> {
          stopped = true;
        },
      };
    },

    async usage(): Promise<AccountUsage | null> {
      return script.accountUsage ?? null;
    },
  };
}
