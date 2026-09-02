/**
 * What a provider tool call is, in terms the policy engine can answer.
 *
 * ## Why this table is maintained rather than derived
 *
 * The same reason `KNOWN_TOOLS` is, and it matters more here. A tool's input
 * shape is provider vocabulary — `Read` takes `file_path`, `Grep` takes `path`,
 * `NotebookEdit` takes `notebook_path` — and ADR-0001 puts that in the adapter.
 * Getting one of these names wrong produces a request with no path, which the
 * policy engine happily decides on the tool name alone. It would not throw, and
 * it would not look wrong in a log.
 *
 * ## Why an unrecognised tool needs no special case
 *
 * It gets a request carrying its name and nothing else, and `decide` refuses it
 * because a profile is an allowlist: a tool the profile does not name does not
 * exist to that session. So a provider tool nobody here has heard of is refused
 * by default, and no branch in this file has to remember to do it.
 *
 * **That is not a theoretical nicety.** It is the whole of the containment for
 * everything outside `KNOWN_TOOLS`, and on 2026-09-02 a session running under
 * `QUARANTINE` — no tools, nothing readable, no network — was measured calling
 * `ToolSearch` and having it succeed. Eighteen tools were reachable by name and
 * none of them was on the list, because the list can only withhold what it
 * names. An allowlist applied to every call, whatever it is called, is the only
 * shape that closes that.
 */

import type { ToolRequest } from '@cortana/policy';

/** How one provider tool's input names the thing it touches, and what it does. */
interface ToolShape {
  /** Input keys that may carry the path, in the order they are preferred. */
  readonly pathKeys?: readonly string[];
  readonly writes?: boolean;
  readonly network?: boolean;
}

/**
 * The provider tools this adapter can describe.
 *
 * Every entry was read from the tool's own input schema rather than guessed. A
 * tool missing from here is not a hole — it is refused unless the profile names
 * it, and a profile that names it gets a decision made on the tool name with no
 * path check, which is why adding one is a decision rather than an oversight.
 */
const SHAPES: Readonly<Record<string, ToolShape>> = {
  Bash: {
    // A shell command is an egress path and a write path, and which one this
    // particular command is cannot be known without parsing it. Deciding
    // security by parsing a shell command is a well-travelled way to be wrong,
    // so both are asserted and the profile decides whether that is acceptable.
    writes: true,
    network: true,
  },
  Edit: { pathKeys: ['file_path'], writes: true },
  Glob: { pathKeys: ['path'] },
  Grep: { pathKeys: ['path'] },
  NotebookEdit: { pathKeys: ['notebook_path'], writes: true },
  Read: { pathKeys: ['file_path'] },
  // A subagent is a session this adapter did not open and cannot see the
  // profile of. Treated as a write because it is the one call here that creates
  // capability rather than using it.
  Task: { writes: true },
  TodoWrite: {},
  WebFetch: { network: true },
  WebSearch: { network: true },
  Write: { pathKeys: ['file_path'], writes: true },
};

/** Tools the provider runs for its own machinery rather than on the model's behalf. */
export const CARRIER_TOOLS: readonly string[] = ['StructuredOutput'];

export function isCarrierTool(tool: string): boolean {
  return CARRIER_TOOLS.includes(tool);
}

/**
 * One provider tool call, as a question the policy engine can answer.
 *
 * A path that is present but not absolute is passed through unchanged rather
 * than resolved here. `decide` refuses it and says why, and resolving it against
 * this process's working directory would be answering a question about a
 * different file — the session's directory is not necessarily this one's.
 */
export function requestFor(tool: string, input: Record<string, unknown>): ToolRequest {
  const shape = SHAPES[tool];
  if (shape === undefined) return { tool };

  const key = shape.pathKeys?.find((candidate) => typeof input[candidate] === 'string');
  const path = key === undefined ? undefined : (input[key] as string);

  return {
    tool,
    ...(path === undefined ? {} : { path }),
    writes: shape.writes === true,
    network: shape.network === true,
  };
}
