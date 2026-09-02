import type { SessionId } from '@cortana/core';
import type { Profile } from '@cortana/policy';
import type { ZodType } from 'zod';

/**
 * What a model is being asked to be, rather than which model it is.
 *
 * [CONCEPTS §3.4](../../../docs/CONCEPTS.md) already speaks in tiers — the main
 * agent "chooses which model tier and effort level each agent runs at" — so the
 * design's own vocabulary is the abstraction. Naming a specific model here would
 * put one provider's catalogue in the port, which is exactly what ADR-0001 says
 * lives in the adapter.
 */
export const MODEL_TIERS = ['fast', 'balanced', 'deep'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === 'string' && (MODEL_TIERS as readonly string[]).includes(value);
}

export interface SessionSpec {
  readonly tier: ModelTier;
  /** Who this agent is. Sent once and cached, not repeated per turn. */
  readonly systemPrompt: string;
  /**
   * What this session may do. **Required, and that is the point.**
   *
   * It could have been optional with a permissive default, and every session
   * opened without thinking about it would then have been permissive. The
   * failure would be silent, would pass every test, and would look exactly like
   * a session that had been considered.
   *
   * Making it required means containment cannot be forgotten: a session opened
   * without a profile does not compile. That is the only enforcement mechanism
   * in this file that costs nothing at runtime and cannot be talked past.
   *
   * A `Profile` is provider-neutral by construction — `@cortana/policy` holds no
   * provider vocabulary, which is why it can sit in the port without violating
   * [ADR-0001](../../../docs/adr/0001-model-access-behind-a-port.md). Turning it
   * into settings some provider reads is the adapter's job, and it is the second
   * of the two layers CONCEPTS §7 requires; the first is `decide`.
   */
  readonly profile: Profile;
}

/**
 * What a turn cost, as reported.
 *
 * The cache counters are not decoration. [Spike 0009](../../../docs/spikes/0009-structured-output.md)
 * repeated one identical call and measured **$0.0201 and $0.6891 — 34×** — with
 * output tokens differing by 1.4×. The cause was prompt-cache state: the
 * expensive turn wrote 110,428 tokens of cache and the cheap one wrote none. What
 * selects between the regimes is not known.
 *
 * So these fields travel together on purpose. A cost without the counters that
 * explain it invites someone to average it, and the average of a 34× spread
 * describes nothing.
 */
export interface TurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** `null` when the adapter has no figure, which is a normal state. */
  readonly costUsd: number | null;
}

export interface TurnResult {
  readonly text: string;
  readonly usage: TurnUsage;
}

export interface StructuredTurnResult<Value> extends TurnResult {
  /** Already validated against the schema that was asked for. */
  readonly value: Value;
}

/**
 * What every session has, whatever shape its answers take.
 *
 * ## Why the answer's shape belongs to the session and not the turn
 *
 * The first version of this port put `turn` and `turnStructured` on one session,
 * which is the obvious design and is not one every adapter could implement.
 * Reading the provider's own interface before writing against it settled it: the
 * output format is a parameter of the call that opens a session, there is no
 * control method to change it afterwards, and no per-message field carries one.
 * A session is prose or it is structured, for its whole life.
 *
 * That could have been worked around — a structured turn could end the session
 * and resume it with a different format — at a cost nothing has measured, against
 * a cold start [spike 0003](../../../docs/spikes/0003-concurrent-sessions.md)
 * put at 5.4–6.2 s. Doing that quietly would have hidden a per-turn cost inside
 * a method that looks free.
 *
 * So the port took the change instead, and [ADR-0001](../../../docs/adr/0001-model-access-behind-a-port.md)
 * is why it is the right way round: **the port must be designed for the lower
 * common denominator.** Every adapter can fix an output shape when a session
 * opens; only some can switch it mid-conversation. A port shaped by the
 * convenience is a port that the next adapter cannot satisfy — which is the
 * failure this whole arrangement exists to prevent.
 *
 * **The open question this leaves**, recorded rather than answered: an agent that
 * must both answer a person in prose and hand the kernel a decision now needs two
 * sessions, and spike 0003 priced a session at 263 MB. Whether that is a real
 * problem depends on whether such an agent exists, which M3 finds out. The resume
 * path is still there if it does, and it needs measuring before it is used.
 */
interface SessionBase {
  readonly id: SessionId;
  readonly tier: ModelTier;
  readonly stopped: boolean;
  /** Idempotent. A stopped session refuses further turns rather than restarting. */
  stop(): Promise<void>;
}

/** A session whose answers are prose. */
export interface ModelSession extends SessionBase {
  turn(prompt: string): Promise<TurnResult>;
}

/**
 * A session whose answers are values of one shape.
 *
 * Every answer is re-validated against the schema before it is returned, per
 * [ADR-0015](../../../docs/adr/0015-structured-output-at-the-model-boundary.md):
 * the provider's enforcement is a strong prior, not a guarantee, and this is the
 * boundary this project controls. A response that cannot be validated raises an
 * `AppError` in the `provider` category, and is never coerced into looking valid.
 */
export interface StructuredSession<Value> extends SessionBase {
  turn(prompt: string): Promise<StructuredTurnResult<Value>>;
}

/**
 * One window of the account's rate limit.
 *
 * [Spike 0013](../../../docs/spikes/0013-usage-headroom.md) found the provider
 * reporting the same quantity on two scales — the usage endpoint gives `87`, the
 * pushed event gives `0.87` — and noted that "a mistake here is a factor of a
 * hundred in a governor's arithmetic". **The port fixes one scale and adapters
 * normalise to it.** Reconciling that is exactly the sort of thing a port is for.
 */
export interface UsageWindow {
  /** Fraction of the window consumed, from 0 to 1. */
  readonly utilization: number;
  readonly resetsAt: Date;
}

/**
 * What the provider will say about the account.
 *
 * Spike 0013 established two things the shape has to respect. It describes the
 * **account, not the session** — concurrent agents share one meter — so it
 * decides whether to start expensive work and is not per-agent accounting. And
 * the window that binds may not be the short one: in the measured run the
 * five-hour window read 37% while the seven-day read 87% and was the one that
 * warned. Windows are therefore a map rather than a pair of named fields.
 */
export interface AccountUsage {
  readonly subscription: string | null;
  readonly windows: Readonly<Record<string, UsageWindow>>;
}

export interface ModelRunner {
  /** Which adapter this is. Recorded against every turn in the audit. */
  readonly name: string;

  /** Opens a session that answers in prose. */
  start(spec: SessionSpec): Promise<ModelSession>;

  /**
   * Opens a session that answers with values of the given shape.
   *
   * The adapter is responsible for getting the model to produce them **and** for
   * whatever that costs in turns — see the note on budgets at the top of
   * `index.ts`.
   */
  startStructured<Value>(
    spec: SessionSpec,
    schema: ZodType<Value>,
  ): Promise<StructuredSession<Value>>;

  /**
   * The account's remaining headroom, or `null` when this adapter cannot say.
   *
   * `null` is a normal answer, not a failure. The endpoint spike 0013 used is
   * called `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, and a
   * kernel that treats its absence as an error would be treating the provider's
   * own stability warning as a promise.
   */
  usage(): Promise<AccountUsage | null>;
}
