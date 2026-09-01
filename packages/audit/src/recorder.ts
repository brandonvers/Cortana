/**
 * Recording turns, and the wrapper that makes it impossible to forget.
 *
 * ## Why this wraps the runner instead of being called by it
 *
 * The alternative was for the adapter to record its own turns, which would put
 * the audit inside the one package permitted to touch a provider — so every
 * future adapter would have to remember to do it, and each would get it slightly
 * differently. Wrapping the port means the recording is written once, works for
 * an adapter nobody has written yet, and is testable against the fake with no
 * provider anywhere near it.
 *
 * It also means the audit cannot drift from the port: anything a session can do
 * passes through here.
 *
 * ## Durable before acknowledged
 *
 * The record is written through M1's writer, in a transaction, **before the
 * result reaches the caller**. That ordering is the whole claim: a turn the
 * caller acted on is a turn the database knows about. Spike 0005 is what makes
 * it worth anything — nothing acknowledged was lost under four `SIGKILL`s per
 * platform.
 *
 * A failed turn is recorded too, and then the failure is re-raised. An audit that
 * only holds successes cannot answer the question anyone actually asks it.
 */

import {
  type Clock,
  type InstanceId,
  isAppError,
  type Logger,
  newInstanceId,
  systemClock,
  uuidV7,
} from '@cortana/core';
import type {
  AccountUsage,
  ModelRunner,
  ModelSession,
  SessionSpec,
  StructuredSession,
  StructuredTurnResult,
  TurnResult,
  TurnUsage,
} from '@cortana/runner';
import type { Writer } from '@cortana/storage';
import type { ZodType } from 'zod';
import { auditTurns } from './schema.ts';

export interface AuditOptions {
  readonly writer: Writer;
  /** Which run of the daemon these turns belong to. */
  readonly instanceId: InstanceId;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

interface TurnRecord {
  readonly sessionId: string;
  readonly adapter: string;
  readonly tier: string;
  readonly kind: 'prose' | 'structured';
  readonly prompt: string;
  readonly response: string;
  readonly outcome: 'ok' | 'failed';
  readonly errorCode: string | null;
  readonly usage: TurnUsage | null;
  readonly startedAt: number;
  readonly durationMs: number;
}

const EMPTY_USAGE: TurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
};

/**
 * Wraps a runner so that every turn it takes is recorded before it is returned.
 *
 * The wrapper is the whole feature. Nothing else in the system has to remember
 * that auditing exists.
 */
export function auditedRunner(runner: ModelRunner, options: AuditOptions): ModelRunner {
  const clock = options.clock ?? systemClock;
  const log = options.logger?.child({ component: 'audit' });

  const record = async (turn: TurnRecord): Promise<void> => {
    await options.writer.write('record a turn', ({ db }) => {
      db.insert(auditTurns)
        .values({
          id: uuidV7(clock.now()) as string,
          instanceId: options.instanceId as string,
          sessionId: turn.sessionId,
          adapter: turn.adapter,
          tier: turn.tier,
          kind: turn.kind,
          prompt: turn.prompt,
          response: turn.response,
          outcome: turn.outcome,
          errorCode: turn.errorCode,
          inputTokens: (turn.usage ?? EMPTY_USAGE).inputTokens,
          outputTokens: (turn.usage ?? EMPTY_USAGE).outputTokens,
          cacheReadTokens: (turn.usage ?? EMPTY_USAGE).cacheReadTokens,
          cacheWriteTokens: (turn.usage ?? EMPTY_USAGE).cacheWriteTokens,
          costUsd: (turn.usage ?? EMPTY_USAGE).costUsd,
          startedAt: turn.startedAt,
          durationMs: turn.durationMs,
        })
        .run();
    });
  };

  /**
   * Runs one turn, records it either way, and gives the caller what it asked
   * for — or the failure, unchanged.
   */
  const around = async <Result extends TurnResult>(
    context: { sessionId: string; tier: string; kind: 'prose' | 'structured'; prompt: string },
    take: () => Promise<Result>,
    describe: (result: Result) => string,
  ): Promise<Result> => {
    const startedAt = clock.now();
    const began = clock.monotonic();

    try {
      const result = await take();
      await record({
        ...context,
        adapter: runner.name,
        response: describe(result),
        outcome: 'ok',
        errorCode: null,
        usage: result.usage,
        startedAt,
        durationMs: Math.round(clock.monotonic() - began),
      });
      return result;
    } catch (error) {
      // Recorded before it is re-raised. An audit holding only successes cannot
      // answer the question anyone actually asks it.
      try {
        await record({
          ...context,
          adapter: runner.name,
          response: '',
          outcome: 'failed',
          errorCode: isAppError(error) ? error.code : 'unrecognised',
          usage: null,
          startedAt,
          durationMs: Math.round(clock.monotonic() - began),
        });
      } catch (writeError) {
        // The turn's failure is the one worth raising. Losing the record of it is
        // worth saying so, and not worth replacing the original error with.
        log?.error('a failed turn could not be recorded', {
          session: context.sessionId,
          error: String(writeError),
        });
      }
      throw error;
    }
  };

  return {
    name: runner.name,

    async start(spec: SessionSpec): Promise<ModelSession> {
      const session = await runner.start(spec);
      return {
        id: session.id,
        tier: session.tier,
        get stopped(): boolean {
          return session.stopped;
        },
        stop: () => session.stop(),
        turn: (prompt) =>
          around(
            { sessionId: session.id as string, tier: session.tier, kind: 'prose', prompt },
            () => session.turn(prompt),
            (result) => result.text,
          ),
      };
    },

    async startStructured<Value>(
      spec: SessionSpec,
      schema: ZodType<Value>,
    ): Promise<StructuredSession<Value>> {
      const session = await runner.startStructured(spec, schema);
      return {
        id: session.id,
        tier: session.tier,
        get stopped(): boolean {
          return session.stopped;
        },
        stop: () => session.stop(),
        turn: (prompt) =>
          around<StructuredTurnResult<Value>>(
            { sessionId: session.id as string, tier: session.tier, kind: 'structured', prompt },
            () => session.turn(prompt),
            // The value as JSON, so the record holds what the kernel acted on
            // rather than the prose the model happened to say alongside it.
            (result) => JSON.stringify(result.value),
          ),
      };
    },

    usage: (): Promise<AccountUsage | null> => runner.usage(),
  };
}

/** Only exported so a caller without a daemon can still record. */
export const anonymousInstance = (): InstanceId => newInstanceId();
