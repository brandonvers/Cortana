/**
 * What a session is allowed to do, expressed so that no provider owns the words.
 *
 * ## Why this is not a settings file
 *
 * The findings this encodes are provider-specific to the character —
 * `Read(//abs/**)` holds where `Read(/abs/**)` leaked four times out of four, and
 * three separately named settings are needed to close a read channel through
 * Bash. It would be shorter to emit those strings from here.
 *
 * It would also put provider knowledge in a package that
 * [ADR-0001](../../../docs/adr/0001-model-access-behind-a-port.md) says must not
 * hold any: the port exists because the provider's terms moved twice in five
 * months, and a policy engine written in one provider's settings vocabulary is a
 * policy engine that has to be rewritten alongside the adapter.
 *
 * So a profile says **what**, and the adapter says **how**. The one-character
 * finding lives in `runner-claude`, next to the syntax it is about, with a test
 * that fails on the wrong form.
 *
 * ## Why a profile is closed rather than open
 *
 * Every field below is a list of what is permitted, not a list of what is
 * forbidden. A session gets nothing it was not given. That is not a style
 * preference: [spike 0011](../../../docs/spikes/0011-quarantine-escape.md) found
 * that a session inherits the operator's MCP servers unless told otherwise — a
 * whole tool surface arriving by default — and an allowlist is the only shape
 * where forgetting something makes a session weaker rather than stronger.
 */

import type { TrustLevel } from '@cortana/core';

/**
 * Whether an OS sandbox is a condition of running at all.
 *
 * `required` is not the same as "we asked for one".
 * [Spike 0010](../../../docs/spikes/0010-non-bash-containment.md) measured the
 * setting that makes the difference for the first time: without it a session
 * whose sandbox is unavailable runs anyway, unsandboxed and silent. A profile
 * that means to be contained has to say that failing to contain it is a failure.
 */
export type SandboxRequirement = 'required' | 'optional' | 'none';

export interface Profile {
  readonly name: string;
  /**
   * The trust of the content this session will handle.
   *
   * [CONCEPTS §7.3](../../../docs/CONCEPTS.md) makes the downgrade to
   * `untrusted` one-way: a session that has touched untrusted content does not
   * become trusted again by finishing with it.
   */
  readonly trust: TrustLevel;
  /**
   * Tools this session may use. Anything absent does not exist to it.
   *
   * Spike 0011 found that a bare tool name in the provider's deny list removes
   * the tool from the session entirely rather than gating it — the strongest
   * lock available, and the reason this is a list of what exists rather than a
   * list of what is allowed.
   */
  readonly tools: readonly string[];
  /** Absolute paths this session may read. */
  readonly readable: readonly string[];
  /** Absolute paths this session may write. */
  readonly writable: readonly string[];
  /**
   * Absolute paths that must not be readable whatever else permits.
   *
   * Kept separate from an empty `readable` on purpose: "this session reads
   * nothing" and "this session must never read *that*" are different statements,
   * and only the second survives someone later widening the first.
   */
  readonly denyRead: readonly string[];
  readonly network: 'allowed' | 'denied';
  readonly sandbox: SandboxRequirement;
  /**
   * Which calls this profile permits are still put to a person first.
   *
   * Separate from everything above because it answers a different question.
   * The fields above say what is *possible*; this says what happens **without a
   * person in the room**. Nothing here can make a refusal into a question —
   * there would be nothing to ask about — so this only ever narrows.
   */
  readonly confirm: ConfirmPolicy;
}

/**
 * `never` runs everything the profile permits. `writes` stops at anything that
 * modifies or leaves the machine. `always` puts every permitted call to a person.
 */
export type ConfirmPolicy = 'never' | 'writes' | 'always';

/**
 * The profile for a disposable agent inspecting content nobody here wrote.
 *
 * [ADR-0007](../../../docs/adr/0007-quarantine-untrusted-content.md) puts one of
 * these in front of anything untrusted, and this is the strictest thing the
 * design can express: **no tools at all**, nothing readable, nothing writable, no
 * network, and a sandbox whose absence stops the session rather than being noted.
 *
 * It needs no tools because it needs no capability. The content arrives in its
 * prompt and its answer is a verdict. Anything it could do beyond that is a way
 * for the content to act, which is the whole thing being prevented.
 */
export const QUARANTINE: Profile = {
  name: 'quarantine',
  trust: 'untrusted',
  tools: [],
  readable: [],
  writable: [],
  denyRead: [],
  network: 'denied',
  sandbox: 'required',
  // Deliberately `never`, which reads backwards for the strictest profile in
  // the system and is the strict answer.
  //
  // A question put to an operator is text on their screen, and a quarantine
  // session is holding content nobody here wrote. Letting it reach the approval
  // path would hand that content a way to compose a sentence a person reads and
  // acts on — an injection surface created by the mechanism meant to contain
  // the injection. It is safe here only because the profile permits nothing:
  // every call is already a refusal, so there is nothing left to ask about.
  confirm: 'never',
};

/**
 * Narrows a profile to untrusted, and never the other way.
 *
 * CONCEPTS §7.3: "if untrusted content reaches a working session anyway, that
 * session drops irreversibly to a restricted profile for the rest of its life".
 * There is deliberately no function here that raises trust.
 */
export function downgraded(profile: Profile): Profile {
  return {
    ...profile,
    name: `${profile.name}+untrusted`,
    trust: 'untrusted',
    tools: [],
    readable: [],
    writable: [],
    network: 'denied',
    sandbox: 'required',
    // For the reason on QUARANTINE: a session that has touched untrusted content
    // must not be able to put a sentence in front of the operator.
    confirm: 'never',
  };
}
