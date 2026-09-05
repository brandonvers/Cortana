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
 * What a profile must be for a session that handles content nobody here wrote.
 *
 * Each entry is a property, the reason it exists, and the measurement behind it.
 * They are data rather than a paragraph in a review checklist because
 * [M3's definition of done](../../../docs/milestones/m3-conversation.md) asks
 * for exactly that: "a generated profile missing one fails a test rather than a
 * review". Five of these are settings whose absence is **silent** — the session
 * runs, looks contained, and is not.
 */
export interface Invariant {
  readonly name: string;
  readonly because: string;
  holds(profile: Profile): boolean;
}

export const CONTAINMENT_INVARIANTS: readonly Invariant[] = [
  {
    name: 'no tools',
    because:
      'the content arrives in the prompt and the answer is a verdict; anything more is a way ' +
      'for the content to act. ADR-0021: the tool list is the allowlist, and an empty one is ' +
      'the only spelling of "nothing" the provider honours',
    holds: (profile) => profile.tools.length === 0,
  },
  {
    name: 'nothing readable',
    because: 'a path this session can reach is a path the content can ask it to read out',
    holds: (profile) => profile.readable.length === 0,
  },
  {
    name: 'nothing writable',
    because: 'an inspection produces a verdict, and a verdict is returned rather than written',
    holds: (profile) => profile.writable.length === 0,
  },
  {
    name: 'no network',
    because:
      'egress is how an inspection becomes an exfiltration. Spike 0011 measured WebFetch ' +
      'succeeding with the locks off and refused with them on',
    holds: (profile) => profile.network === 'denied',
  },
  {
    name: 'a sandbox that must be there',
    because:
      'spike 0010 measured the difference: without failIfUnavailable a session whose sandbox ' +
      'is missing runs anyway, uncontained and unannounced',
    holds: (profile) => profile.sandbox === 'required',
  },
  {
    name: 'untrusted',
    because:
      'CONCEPTS §7.3 makes the downgrade one-way, and a session inspecting untrusted content ' +
      'that called itself trusted would be the one place the rule had an exception',
    holds: (profile) => profile.trust === 'untrusted',
  },
  {
    name: 'asks nobody anything',
    because:
      'a question is text an operator reads and acts on. A session holding content nobody ' +
      'here wrote must not be able to compose one',
    holds: (profile) => profile.confirm === 'never',
  },
];

/** Which invariants this profile fails. Empty means it is contained. */
export function containmentFailures(profile: Profile): readonly Invariant[] {
  return CONTAINMENT_INVARIANTS.filter((invariant) => !invariant.holds(profile));
}

export interface QuarantineOptions {
  /**
   * Where the content came from — a mailbox, a URL, a file.
   *
   * Names the profile so a refusal in a log says which inspection it belonged
   * to. It reaches no permission decision, and it must not: it is frequently a
   * string the content itself supplied.
   */
  readonly source: string;
  /**
   * Paths that must never be readable, whatever else permits.
   *
   * Redundant against `readable: []` and kept anyway, because the two say
   * different things: "this session reads nothing" and "this must never be read"
   * do not fail the same way when somebody later widens the first.
   */
  readonly denyRead?: readonly string[];
}

/**
 * The profile for a disposable agent inspecting content nobody here wrote.
 *
 * [ADR-0007](../../../docs/adr/0007-quarantine-untrusted-content.md) puts one of
 * these in front of anything untrusted. **Generated rather than written**, and
 * that is a requirement rather than a convenience: every property above is one
 * a hand-written profile can omit without producing an error, and the session
 * then runs looking exactly like a contained one.
 *
 * It checks its own output before returning it, so a future edit that drops a
 * property fails where the edit is rather than wherever the profile is used.
 */
export function quarantineProfile(options: QuarantineOptions): Profile {
  const profile: Profile = {
    name: `quarantine:${options.source}`,
    trust: 'untrusted',
    tools: [],
    readable: [],
    writable: [],
    denyRead: [...(options.denyRead ?? [])],
    network: 'denied',
    sandbox: 'required',
    confirm: 'never',
  };

  // Deliberately unreachable while the literal above is correct, and that is
  // what it is for: it fires when somebody edits that literal, at the edit
  // rather than wherever the profile is later used. No test can reach it —
  // reaching it means the generator is already wrong — so `containmentFailures`
  // is tested directly instead, against a profile widened one property at a
  // time. This is recorded rather than left as a silent gap in a mutation run.
  const failures = containmentFailures(profile);
  if (failures.length > 0) {
    throw new Error(
      `the quarantine generator produced an uncontained profile, failing: ${failures
        .map((invariant) => invariant.name)
        .join(', ')}`,
    );
  }
  return profile;
}

/**
 * The quarantine profile for content with nothing more specific to say about it.
 *
 * Produced by the generator rather than written out, so that there is no
 * hand-written containment profile anywhere in this repository to copy.
 */
export const QUARANTINE: Profile = quarantineProfile({ source: 'unattributed' });

export interface WorkingOptions {
  readonly name: string;
  readonly tools?: readonly string[];
  readonly readable?: readonly string[];
  readonly writable?: readonly string[];
  readonly denyRead?: readonly string[];
  readonly network?: 'allowed' | 'denied';
  readonly confirm?: ConfirmPolicy;
}

/**
 * The profile for an agent that works on the owner's behalf.
 *
 * Generated for the same reason the quarantine one is — nothing about
 * containment should be typed out twice — but it makes a weaker claim, and the
 * claim it makes is the coupling below rather than a list of invariants. A
 * working profile is *supposed* to be able to do things; what it must not do is
 * be able to do them without the sandbox.
 *
 * **Granting a tool requires a sandbox.** With `tools: []` the sandbox is moot —
 * there is nothing to contain, and requiring one would refuse to start on a host
 * that has none, for no benefit. The moment a tool is granted that stops being
 * true, and the danger is that nobody notices: the setting that was harmless
 * when it was written is a hole after somebody adds one line elsewhere. So the
 * requirement is derived from the tools rather than configured beside them.
 */
export function workingProfile(options: WorkingOptions): Profile {
  const tools = [...(options.tools ?? [])];
  return {
    name: options.name,
    trust: 'owner',
    tools,
    readable: [...(options.readable ?? [])],
    writable: [...(options.writable ?? [])],
    denyRead: [...(options.denyRead ?? [])],
    network: options.network ?? 'denied',
    // Derived, never passed in. See above.
    sandbox: tools.length === 0 ? 'none' : 'required',
    confirm: options.confirm ?? 'writes',
  };
}

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
