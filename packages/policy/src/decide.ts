/**
 * The decision a tool call gets, and who is allowed to make it.
 *
 * [CONCEPTS §7.3](../../../docs/CONCEPTS.md) is unambiguous about the last part:
 * "tool allowlists in frontmatter remain ergonomics, never a boundary". An agent
 * may say what it would like; nothing an agent says about itself is permitted to
 * be the only thing between it and a file. This module is what actually decides,
 * and M3 is the first milestone able to violate that, which is why it is stated
 * here rather than only in the design.
 */

import type { Profile } from './profile.ts';

export interface ToolRequest {
  readonly tool: string;
  /** The absolute path the call would touch, when it touches one. */
  readonly path?: string;
  /** Whether the call would modify what it touches. */
  readonly writes?: boolean;
  /** Whether the call would reach the network. */
  readonly network?: boolean;
}

export type Verdict = 'allow' | 'deny' | 'ask';

export interface Decision {
  readonly verdict: Verdict;
  /** Why, in a sentence an operator being asked to approve can act on. */
  readonly because: string;
}

const deny = (because: string): Decision => ({ verdict: 'deny', because });

/**
 * Whether `path` sits inside `root`.
 *
 * Compared as path segments rather than as text, because `/var/lib/cortana-old`
 * begins with `/var/lib/cortana` and is a different directory. A prefix test
 * here is a containment bug, and it is the kind that looks correct in every
 * example anyone writes down.
 */
export function isInside(root: string, path: string): boolean {
  if (root === path) return true;
  const bounded = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(bounded);
}

/**
 * What a profile says about one tool call.
 *
 * The order is deliberate and each step is a separate reason. A denial by
 * `denyRead` outranks permission by `readable`, because the two exist to say
 * different things and only the stricter one survives someone widening the
 * other.
 */
export function decide(profile: Profile, request: ToolRequest): Decision {
  if (!profile.tools.includes(request.tool)) {
    return deny(`the ${profile.name} profile does not have the ${request.tool} tool`);
  }

  if (request.network === true && profile.network !== 'allowed') {
    return deny(`the ${profile.name} profile does not reach the network`);
  }

  if (request.path !== undefined) {
    if (!request.path.startsWith('/')) {
      // A relative path is resolved against something this module cannot see,
      // so every containment check below would be answering a question about a
      // different file.
      return deny(`"${request.path}" is not an absolute path, so it cannot be checked`);
    }

    for (const forbidden of profile.denyRead) {
      if (isInside(forbidden, request.path)) {
        return deny(`${forbidden} is denied to every profile that names it`);
      }
    }

    const roots = request.writes === true ? profile.writable : profile.readable;
    const allowed = roots.some((root) => isInside(root, request.path as string));
    if (!allowed) {
      const verb = request.writes === true ? 'write' : 'read';
      return deny(`the ${profile.name} profile cannot ${verb} ${request.path}`);
    }
  }

  return { verdict: 'allow', because: `permitted by the ${profile.name} profile` };
}

/**
 * Whether a call this profile permits is still put to a person.
 *
 * `writes` covers modification and egress together, which is one predicate for
 * two things on purpose: from an operator's point of view "it changed something"
 * and "it left the machine" are the same question — *is this irreversible?* —
 * and a profile that asked about one and not the other would be answering half
 * of it.
 */
export function needsConfirmation(profile: Profile): (request: ToolRequest) => boolean {
  if (profile.confirm === 'never') return () => false;
  if (profile.confirm === 'always') return () => true;
  return (request) => request.writes === true || request.network === true;
}

/**
 * What actually happens to one call under one profile: the security decision,
 * and then the profile's own answer to whether a person should see it first.
 *
 * This is the function a session uses. `decide` and `decideWithConfirmation`
 * stay separate underneath it because they are separately meaningful — one is a
 * boundary and one is a preference — but a caller reaching for the boundary
 * alone gets a session that never asks anybody anything, and that is not a
 * mistake anyone would notice from the outside.
 */
export function decideForSession(profile: Profile, request: ToolRequest): Decision {
  return decideWithConfirmation(profile, request, needsConfirmation(profile));
}

/**
 * The same decision, with anything the profile permits but an operator has asked
 * to be consulted about turned into a question.
 *
 * Separate from `decide` because they answer different questions and only one of
 * them is a security boundary. `decide` says what is *possible*; this says what
 * happens without a person. A profile that permits nothing cannot be made to ask
 * — there is nothing to ask about — so raising a denial to a question is not
 * something this can do, in either direction.
 */
export function decideWithConfirmation(
  profile: Profile,
  request: ToolRequest,
  needsConfirmation: (request: ToolRequest) => boolean,
): Decision {
  const decision = decide(profile, request);
  if (decision.verdict !== 'allow') return decision;
  if (!needsConfirmation(request)) return decision;

  return {
    verdict: 'ask',
    because: `${decision.because}, but this kind of call is confirmed before it runs`,
  };
}
