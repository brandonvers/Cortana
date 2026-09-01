/**
 * The Claude adapter: the only place in this repository that talks to a provider.
 *
 * `scripts/check-boundaries.mjs` has enforced that since M1 step 0, when there
 * was nothing to catch. This is the file it was written for.
 *
 * ## The SDK is loaded dynamically, on purpose
 *
 * [ADR-0020](../../../docs/adr/0020-the-provider-sdk-is-a-peer-dependency.md)
 * makes it an optional peer the user installs, so that accepting Anthropic's
 * proprietary terms is their act rather than a side effect of installing this. A
 * static import would end the process at module load on a machine that has not
 * done that, with `ERR_MODULE_NOT_FOUND` and a stack trace. The ADR asks for a
 * sentence naming the package and the reason instead, so the import happens when
 * a runner is created and its failure is an ordinary error.
 */

import { AppError, type Logger, newSessionId } from '@cortana/core';
import type {
  AccountUsage,
  ModelRunner,
  ModelSession,
  ModelTier,
  SessionSpec,
  StructuredSession,
  StructuredTurnResult,
  TurnResult,
} from '@cortana/runner';
import type { ZodType } from 'zod';
import {
  accountUsageFrom,
  DEFAULT_MODELS,
  failureFrom,
  jsonSchemaFor,
  type ProviderResult,
  totalCostFrom,
  usageFrom,
} from './translate.ts';

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/**
 * A rate-limit warning the provider pushed, unasked.
 *
 * [Spike 0013](../../../docs/spikes/0013-usage-headroom.md) found this and
 * called it the best result of that run: "the provider pushes a warning with the
 * threshold that triggered it. The governor does not have to poll and does not
 * have to invent its own thresholds: it is told when the account crosses one,
 * which window, and when that window resets."
 *
 * It sits on the adapter's options rather than on the port because ADR-0001 says
 * where a provider-specific convenience belongs: "inside the adapter", to be
 * "simply absent under another one". If a second adapter turns out to push the
 * same thing, that is when it earns a place in the port.
 *
 * `utilization` is already a fraction here. The endpoint reports `87` and this
 * reports `0.87` — the asymmetry spike 0013 warned is "a factor of a hundred in
 * a governor's arithmetic" — so it is passed through rather than divided, and
 * this comment is why nobody should add a division later.
 */
export interface RateLimitWarning {
  readonly status: 'allowed' | 'allowed_warning' | 'rejected';
  /** Which window. The binding one is not always the short one. */
  readonly window: string | null;
  /** A fraction from 0 to 1, already on the port's scale. */
  readonly utilization: number | null;
  /** The threshold whose crossing caused the warning, when the provider says. */
  readonly surpassedThreshold: number | null;
  readonly resetsAt: Date | null;
}

export interface ClaudeRunnerOptions {
  /** Overrides the tier-to-model mapping. */
  readonly models?: Readonly<Record<ModelTier, string>>;
  /** A ceiling the provider enforces per session. Absent means none. */
  readonly maxBudgetUsd?: number;
  readonly logger?: Logger;
  /**
   * Called when the provider pushes a rate-limit warning during a turn.
   *
   * Without this the events are read off the stream and discarded, which is what
   * this adapter did until the meaning of that was noticed: the provider is
   * telling the system it is running out of headroom, and nobody is listening.
   */
  readonly onRateLimit?: (warning: RateLimitWarning) => void;
  /**
   * How long to wait for a turn before giving up on it.
   *
   * A failing session is contained by the error taxonomy — an `AppError` is not
   * a crash — but a session that simply never answers is contained by nothing,
   * and a kernel awaiting it waits for as long as the process lives.
   *
   * The default is deliberately generous. A turn can legitimately run for
   * minutes when the model is working, and a deadline that cuts real work is
   * worse than none: it turns a slow answer into a failure and invites someone
   * to raise it until it stops mattering. Ten minutes is past anything observed
   * — spike 0005's model turn was 11 seconds — and still finite.
   */
  readonly turnTimeoutMs?: number;
  /**
   * Where a conversation comes from. Defaults to the provider's own.
   *
   * This is a seam rather than a convenience. Everything in this file that is
   * not translation is orchestration — a deadline, a stopped session, a stream
   * that ends early — and none of it is checkable without something to stand in
   * for the provider. It leaks nothing: `ProviderQuery` is declared here and
   * names no provider type, which is the same reason the boundary check is
   * satisfied by this file and by nothing else.
   */
  readonly openConversation?: (params: unknown) => ProviderQuery;
}

const DEFAULT_TURN_TIMEOUT_MS = 600_000;

/** Narrows a pushed event into the shape above, or `null` if it is not one. */
export function rateLimitWarningFrom(message: Record<string, unknown>): RateLimitWarning | null {
  if (message['type'] !== 'rate_limit_event') return null;

  const info = message['rate_limit_info'];
  if (!info || typeof info !== 'object') return null;
  const raw = info as Record<string, unknown>;

  const status = raw['status'];
  if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') return null;

  // resetsAt is epoch *seconds* here, unlike the endpoint's ISO string. Two
  // representations of the same instant, a third of the way through one SDK.
  const resets = typeof raw['resetsAt'] === 'number' ? new Date(raw['resetsAt'] * 1_000) : null;

  return {
    status,
    window: typeof raw['rateLimitType'] === 'string' ? raw['rateLimitType'] : null,
    utilization: typeof raw['utilization'] === 'number' ? raw['utilization'] : null,
    surpassedThreshold:
      typeof raw['surpassedThreshold'] === 'number' ? raw['surpassedThreshold'] : null,
    resetsAt: resets && !Number.isNaN(resets.getTime()) ? resets : null,
  };
}

/** The provider surface this adapter uses, named so the rest can stay untyped. */
export interface ProviderQuery extends AsyncIterable<Record<string, unknown>> {
  close?: () => void;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<
    Record<string, unknown>
  >;
}

/**
 * A queue the provider reads user messages from.
 *
 * Streaming input is what makes one session take many turns; the alternative is
 * a fresh process per turn, which is the cold start spike 0003 measured at
 * 5.4–6.2 seconds.
 */
class PromptQueue implements AsyncIterable<unknown> {
  #pending: unknown[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  push(text: string): void {
    this.#pending.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    this.#wake?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    for (;;) {
      while (this.#pending.length > 0) yield this.#pending.shift();
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = () => {
          this.#wake = null;
          resolve();
        };
      });
    }
  }
}

async function loadSdk(): Promise<{ query: (params: unknown) => ProviderQuery }> {
  try {
    return (await import(SDK_PACKAGE)) as { query: (params: unknown) => ProviderQuery };
  } catch (error) {
    throw new AppError(
      `${SDK_PACKAGE} is not installed. It is a peer dependency you install yourself, ` +
        'because it is proprietary and accepting its terms is your decision rather than ' +
        `this project's — see docs/adr/0020. Install it with: pnpm add ${SDK_PACKAGE}`,
      {
        category: 'config',
        code: 'provider-sdk-missing',
        detail: { package: SDK_PACKAGE },
        cause: error,
      },
    );
  }
}

interface OpenOptions {
  readonly spec: SessionSpec;
  readonly schema?: ZodType<unknown>;
}

export async function createClaudeRunner(options: ClaudeRunnerOptions = {}): Promise<ModelRunner> {
  const query = options.openConversation ?? (await loadSdk()).query;
  const models = options.models ?? DEFAULT_MODELS;
  const log = options.logger?.child({ component: 'runner-claude' });

  /** Sessions still open, so the account meter has somewhere to be asked. */
  const live = new Set<ProviderQuery>();

  const timeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  // Monotonic, so a deadline is not moved by the clock being corrected under it.
  const clock = () => performance.now();

  const open = (open: OpenOptions) => {
    const id = newSessionId();
    const queue = new PromptQueue();
    let stopped = false;
    let totalCostUsd = 0;

    const conversation = query({
      prompt: queue,
      options: {
        model: models[open.spec.tier],
        systemPrompt: open.spec.systemPrompt,
        settingSources: [],
        // A session inherits the operator's MCP servers unless both are set —
        // measured in spike 0011 and not a default worth trusting.
        strictMcpConfig: true,
        mcpServers: {},
        ...(open.schema
          ? { outputFormat: { type: 'json_schema', schema: jsonSchemaFor(open.schema) } }
          : {}),
        ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
      },
    });
    live.add(conversation);

    const messages = conversation[Symbol.asyncIterator]();

    const timers = new Set<NodeJS.Timeout>();
    const clearTimers = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };

    const giveUp = (): AppError => {
      // Interrupting is a courtesy to the provider, not a condition of giving
      // up: the caller is told either way, and a session that ignores an
      // interrupt is exactly the session this deadline exists for.
      try {
        (conversation as { interrupt?: () => unknown }).interrupt?.();
      } catch (error) {
        log?.debug('interrupting a timed-out turn complained', { error: String(error) });
      }
      stopped = true;
      return new AppError(
        `the provider did not answer within ${timeoutMs} ms, and the session has been given up on`,
        { category: 'timeout', code: 'turn-timed-out', detail: { session: id, timeoutMs } },
      );
    };

    const runTurn = async (prompt: string): Promise<{ result: ProviderResult }> => {
      if (stopped) {
        throw new AppError('this session has stopped and will not take another turn', {
          category: 'provider',
          code: 'session-stopped',
          detail: { session: id },
        });
      }

      queue.push(prompt);
      const deadline = clock() + timeoutMs;

      for (;;) {
        const remaining = deadline - clock();
        if (remaining <= 0) throw giveUp();

        const next = await Promise.race([
          messages.next(),
          new Promise<'timed-out'>((resolve) => {
            const timer = setTimeout(() => resolve('timed-out'), remaining);
            // Not unref'd: a turn in flight is a reason for the process to stay
            // alive, and letting the loop empty underneath it would end the
            // daemon mid-answer.
            timers.add(timer);
          }),
        ]);

        if (next === 'timed-out') throw giveUp();
        if (next.done) {
          throw new AppError('the provider ended the session before answering', {
            category: 'provider',
            code: 'session-ended-early',
            detail: { session: id },
          });
        }
        const warning = rateLimitWarningFrom(next.value);
        if (warning) {
          options.onRateLimit?.(warning);
          log?.warn('the provider warned about rate limits', {
            status: warning.status,
            window: warning.window ?? '(unnamed)',
            utilization: warning.utilization ?? -1,
          });
          continue;
        }

        if (next.value['type'] !== 'result') continue;

        const result = next.value as ProviderResult;
        const failure = failureFrom(result);
        clearTimers();
        if (failure) throw failure;
        return { result };
      }
    };

    const finish = (result: ProviderResult) => {
      const usage = usageFrom(result, totalCostUsd);
      totalCostUsd = totalCostFrom(result, totalCostUsd);
      return usage;
    };

    return {
      id,
      tier: open.spec.tier,
      get stopped(): boolean {
        return stopped;
      },
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        clearTimers();
        queue.close();
        live.delete(conversation);
        try {
          conversation.close?.();
        } catch (error) {
          // Closing a session that has already gone is not a failure worth
          // raising during a shutdown that is trying to be tidy.
          log?.debug('closing a provider session complained', { error: String(error) });
        }
      },
      runTurn,
      finish,
      conversation,
    };
  };

  return {
    name: 'claude',

    async start(spec: SessionSpec): Promise<ModelSession> {
      const session = open({ spec });
      return {
        id: session.id,
        tier: session.tier,
        get stopped(): boolean {
          return session.stopped;
        },
        stop: () => session.stop(),
        async turn(prompt: string): Promise<TurnResult> {
          const { result } = await session.runTurn(prompt);
          return {
            text: typeof result.result === 'string' ? result.result : '',
            usage: session.finish(result),
          };
        },
      };
    },

    async startStructured<Value>(
      spec: SessionSpec,
      schema: ZodType<Value>,
    ): Promise<StructuredSession<Value>> {
      const session = open({ spec, schema: schema as ZodType<unknown> });
      return {
        id: session.id,
        tier: session.tier,
        get stopped(): boolean {
          return session.stopped;
        },
        stop: () => session.stop(),
        async turn(prompt: string): Promise<StructuredTurnResult<Value>> {
          const { result } = await session.runTurn(prompt);
          const usage = session.finish(result);

          // ADR-0015: the provider's enforcement is a strong prior, not a
          // guarantee, and this is the boundary this project controls. Validated
          // again here even though the schema was sent with the request.
          const parsed = schema.safeParse(result.structured_output);
          if (!parsed.success) {
            throw new AppError('the model returned a value the schema rejected', {
              category: 'provider',
              code: 'structured-output-invalid',
              // The value itself is deliberately absent: it is whatever the
              // model said, which may be whatever the operator typed.
              detail: { session: session.id, issues: parsed.error.issues.length },
              cause: parsed.error,
            });
          }

          return {
            text: typeof result.result === 'string' ? result.result : '',
            value: parsed.data,
            usage,
          };
        },
      };
    },

    /**
     * The account meter, which the provider only exposes through a live session.
     *
     * That is a finding rather than a limitation of this code: the SDK's usage
     * method is a control request on an open conversation. Opening one just to
     * ask would cost a session — 263 MB and a cold start, per spike 0003 — so
     * with nothing open the honest answer is `null`, which the port already
     * documents as normal.
     */
    async usage(): Promise<AccountUsage | null> {
      for (const conversation of live) {
        const read = conversation.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
        if (typeof read !== 'function') continue;
        try {
          return accountUsageFrom(await read.call(conversation));
        } catch (error) {
          log?.debug('the provider refused to report account usage', { error: String(error) });
        }
      }
      return null;
    },
  };
}
