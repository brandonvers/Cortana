/**
 * The `ModelRunner` port: everything the kernel is allowed to know about talking
 * to a model.
 *
 * [ADR-0001](../../../docs/adr/0001-model-access-behind-a-port.md) is the reason
 * this package exists, and its reasoning is worth restating because it decides
 * what belongs here. The provider's position on third-party harnesses moved
 * twice in five months. The mitigation is that provider contact lives in one
 * package, so a change in terms rewrites one adapter rather than the project —
 * and that mitigation is worth nothing unless a second adapter could actually be
 * written. The ADR is explicit: **the port must be designed for the lower common
 * denominator**, and provider-specific conveniences live inside the adapter and
 * are simply absent under another one.
 *
 * So the test applied to everything below is not "can the current SDK do this",
 * it is "would a second adapter be able to". Four consequences, each of which
 * removed something that looked like it belonged:
 *
 * **No turn budget.** [ADR-0015](../../../docs/adr/0015-structured-output-at-the-model-boundary.md)
 * measured that structured output is delivered through a carrier tool call, that
 * whether it fits in the same turn depends on the model, and that a budget tuned
 * against one model breaks silently on another with a symptom — `error_max_turns`
 * — naming nothing about the cause. A port that asked the caller for a number
 * would be asking it to know a provider detail the ADR says must be derived
 * rather than inherited. **The caller declares intent; the adapter arranges the
 * mechanism.** The contract below holds every adapter to it.
 *
 * **No verb for subagents.** They look like they belong: ADR-0004 adopted them
 * deliberately, and they would be the hardest thing for a second adapter to
 * provide. But a resident's *session* spawns them through its own tool surface
 * when the model decides to — the kernel never asks for one. Nothing to express.
 *
 * **No streaming.** Nothing consumes it until the conversation loop in M3, and a
 * shape designed without a consumer is a guess that later has to be honoured.
 *
 * **No tools and no effort level.** Same reason. [CONCEPTS §3.4](../../../docs/CONCEPTS.md)
 * assigns both, and the thing that assigns them is the main agent, which does not
 * exist yet.
 */

export type { ContractCase } from './contract.ts';
export { modelRunnerContract } from './contract.ts';
export type {
  AccountUsage,
  Approve,
  ModelRunner,
  ModelSession,
  ModelTier,
  SessionSpec,
  StructuredSession,
  StructuredTurnResult,
  TurnResult,
  TurnUsage,
  UsageWindow,
} from './port.ts';
export { isModelTier, MODEL_TIERS } from './port.ts';
