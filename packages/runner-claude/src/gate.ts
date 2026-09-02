/**
 * Every tool call, decided against the profile, before it runs.
 *
 * ## Why this exists, and what it replaced
 *
 * Until 2026-09-02 a profile reached the provider as two things: an allowlist of
 * tool *names* to withhold, and deny rules for paths. Four measurements on that
 * date established that neither was what the design believed.
 *
 * 1. A session under `QUARANTINE` — no tools, nothing readable, no network —
 *    **called `ToolSearch` and it succeeded**, and listed eighteen reachable
 *    tools of which `KNOWN_TOOLS` named none. Withholding by name can only
 *    reach names this repository knows, and the provider's catalogue is larger
 *    than that and changes without asking.
 * 2. `canUseTool` — the transport this project's open questions had already
 *    settled on for permission escalation — **never fired for `Read`**. It is
 *    the *ask* surface: a call the provider resolves to allow on its own never
 *    reaches it. A session granted `Read` read a file well outside `readable`
 *    and nothing was consulted.
 * 3. The provider's `tools` option is the allowlist, and it says so where
 *    `allowedTools` is documented: "To restrict which tools are available, use
 *    the `tools` option instead", with `[]` disabling every built-in tool.
 *    With it, the same quarantine session answers `NONE`.
 * 4. A **`PreToolUse` hook fires where `canUseTool` does not** — including for
 *    `Read` — and its `deny` holds. The file outside `readable` came back
 *    `CANNOT`.
 *
 * So `Profile.readable`, `writable` and `denyRead` are enforced **here** or
 * nowhere, and this file is the difference between a profile that describes
 * containment and one that is containment.
 *
 * ## Why the same decision is made twice
 *
 * The hook and the permission callback both call this, and that is the standing
 * rule rather than duplication: a property enforced once is not enforced. They
 * are separate surfaces in the provider with separate failure modes, and
 * measurement 2 above is what a surface silently not covering a case looks like.
 *
 * A hook `allow` short-circuits the callback, so under normal operation only the
 * hook runs — which means the callback costs nothing and covers anything the
 * hook did not see.
 */

import type { Logger } from '@cortana/core';
import { decideForSession, type Profile } from '@cortana/policy';
import type { Approve } from '@cortana/runner';
import { isCarrierTool, requestFor } from './tools.ts';

export interface GateOutcome {
  readonly allow: boolean;
  /** Why not, in words that reach the model as the reason its call failed. */
  readonly because: string;
}

const ALLOWED: GateOutcome = { allow: true, because: '' };

export interface GateOptions {
  readonly profile: Profile;
  readonly approve?: Approve;
  readonly logger?: Logger;
  readonly session: string;
}

/**
 * Builds the decision function both provider surfaces call.
 *
 * It fails closed in four separate ways, because each is a way a permission
 * check quietly stops being one: a tool the profile does not name is refused by
 * the allowlist, a path outside the profile is refused, an `ask` with nobody to
 * ask is a refusal, and **a defect in this function is a refusal** rather than
 * an error the provider is free to interpret generously.
 */
export function createGate(
  options: GateOptions,
): (tool: string, input: Record<string, unknown>) => Promise<GateOutcome> {
  const log = options.logger;

  return async (tool, input) => {
    // The provider's own end-turn machinery, not the model reaching for a
    // capability. Refusing it contains nothing and breaks structured output,
    // which is the mechanism ADR-0015 requires at this very boundary. Measured
    // on 2026-09-02: a structured session under `tools: []` still answers.
    if (isCarrierTool(tool)) return ALLOWED;

    try {
      const request = requestFor(tool, input);
      const decision = decideForSession(options.profile, request);
      // Every call, at debug. The question after a refusal is "which call, and
      // why", and the answer is otherwise nowhere: the refusal reaches the model
      // as a message, and the model paraphrases it.
      log?.debug('decided a tool call', {
        session: options.session,
        tool,
        verdict: decision.verdict,
      });

      if (decision.verdict === 'allow') return ALLOWED;
      if (decision.verdict === 'deny') return { allow: false, because: decision.because };

      const approve = options.approve;
      if (approve === undefined) {
        log?.warn('a call needed approval and this session has nobody to ask', {
          session: options.session,
          tool,
        });
        return { allow: false, because: `${decision.because}, and nobody is available to ask` };
      }

      return (await approve(request, decision))
        ? ALLOWED
        : { allow: false, because: 'refused by the operator' };
    } catch (error) {
      log?.error('deciding a tool call failed, and the call was refused', {
        session: options.session,
        tool,
        error: String(error),
      });
      return { allow: false, because: 'the policy engine could not decide this call' };
    }
  };
}
