/**
 * A profile, rendered into the settings the provider actually reads.
 *
 * The abstract half is in `@cortana/policy`, which says *what* a session may do
 * and holds no provider vocabulary. This is *how*, and it lives here because
 * every finding below is specific to one provider down to the character — which
 * is exactly what [ADR-0001](../../../docs/adr/0001-model-access-behind-a-port.md)
 * says belongs in an adapter.
 *
 * Five spikes are behind this file. Each of the settings it emits was measured
 * rather than read from a document, and **five of them fail silently when
 * absent**: the session runs, looks contained, and is not.
 */

import type { Profile } from '@cortana/policy';

/**
 * Every tool the provider offers that a profile might withhold.
 *
 * Naming them is the point. [Spike 0011](../../../docs/spikes/0011-quarantine-escape.md)
 * found that a **bare tool name** in the deny list removes the tool from the
 * session entirely, rather than gating it behind a callback — the strongest lock
 * available. A tool that is not on this list cannot be removed by a profile,
 * which is why the list is maintained rather than derived: a new provider tool
 * is a decision, not an inheritance.
 */
export const KNOWN_TOOLS: readonly string[] = [
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
];

/**
 * A path as a deny rule, in the spelling that works.
 *
 * [Spike 0011](../../../docs/spikes/0011-quarantine-escape.md) measured both
 * forms against the same target: `Read(//abs/path/**)` holds, and
 * `Read(/abs/path/**)` **leaked four times out of four**. One slash. The
 * assertion below is not defensive programming, it is the finding: a rule built
 * with the wrong number of leading slashes is a rule that does nothing, and it
 * looks identical in a log.
 */
export function readDenyRule(absolutePath: string): string {
  if (!absolutePath.startsWith('/')) {
    throw new Error(`a deny rule needs an absolute path, got "${absolutePath}"`);
  }
  const rule = `Read(/${absolutePath}/**)`;
  if (!rule.startsWith('Read(//') || rule.startsWith('Read(///')) {
    throw new Error(`deny rule has the wrong number of leading slashes: ${rule}`);
  }
  return rule;
}

export interface ProviderSettings {
  /**
   * The base set of built-in tools this session gets at all.
   *
   * This is the allowlist, and it is the difference between a profile that
   * describes containment and one that is containment. Everything else here
   * withholds tools **by name**, which can only reach names this file knows: on
   * 2026-09-02 a session under `QUARANTINE` — no tools, nothing readable, no
   * network — was measured calling `ToolSearch` successfully, and listing
   * eighteen reachable tools of which `KNOWN_TOOLS` named none.
   *
   * The provider documents the fix in the option it points to from
   * `allowedTools`: "To restrict which tools are available, use the `tools`
   * option instead", where an empty array disables every built-in tool. A
   * profile's `tools` field is that list and always was.
   */
  readonly tools: readonly string[];
  readonly permissions: { readonly deny: readonly string[]; readonly allow: readonly string[] };
  readonly sandbox: Record<string, unknown>;
  readonly strictMcpConfig: boolean;
  readonly mcpServers: Record<string, never>;
  readonly settingSources: readonly string[];
}

/**
 * Renders a profile into provider settings.
 *
 * Every line here answers a measurement:
 *
 * - **Tools absent from the profile are denied by bare name**, which removes
 *   them (spike 0011) rather than leaving them to a callback that can be talked
 *   past.
 * - **`denyRead` paths become rooted `Read(//…/**)` rules** (spike 0011), and
 *   the same paths are repeated in `sandbox.filesystem.denyRead` (spike 0012)
 *   because they close the same door from two sides and only one of them applies
 *   to a spawned command.
 * - **`autoAllowBashIfSandboxed: false`** (spike 0012). Left at its default, a
 *   sandboxed command skips the permission callback entirely, and Bash becomes a
 *   read channel around every rule above it.
 * - **`allowUnsandboxedCommands: false`**, so a command that cannot be
 *   sandboxed does not simply run.
 * - **`failIfUnavailable`** when the profile requires a sandbox (spike 0010).
 *   Without it a session whose sandbox is unavailable runs anyway, uncontained
 *   and unannounced.
 * - **`strictMcpConfig` with an empty server map** (spike 0011), or the session
 *   inherits whatever MCP servers the operator has configured — a tool surface
 *   nobody chose for it.
 * - **`settingSources: []`**, so the profile is the whole of what this session
 *   is, rather than the profile plus whatever is in the operator's files.
 *
 * ## One thing it does not render, named rather than faked
 *
 * `profile.network` reaches nothing here. For every profile written so far that
 * is harmless — the network tools are withheld by name like any other, and the
 * quarantine profile has no tools at all — but a profile that denied the network
 * *and* granted `Bash` would have an open egress path and a field claiming
 * otherwise.
 *
 * The sandbox has settings for it. **None of them has been measured**, and this
 * project's rule is that a property enforced once is not enforced, which makes
 * an unmeasured security setting worse than an absent one: it reads as a closed
 * door. So the gap is recorded and the door is left visibly open until a spike
 * shuts it. `settingsFor` refuses that combination below rather than rendering
 * something that looks like containment.
 */
/** Tools that reach the network by running whatever they are given. */
const EGRESS_TOOLS: readonly string[] = ['Bash'];

export function settingsFor(profile: Profile): ProviderSettings {
  // Refused rather than rendered. The alternative is a profile that says the
  // network is denied, settings that say nothing about the network, and a shell
  // that can reach it — three statements where two of them are wrong and the
  // wrong ones are the reassuring ones.
  if (profile.network === 'denied') {
    const egress = profile.tools.filter((tool) => EGRESS_TOOLS.includes(tool));
    if (egress.length > 0) {
      throw new Error(
        `the "${profile.name}" profile denies the network and grants ${egress.join(', ')}, ` +
          'and nothing here has been measured to close that path — see the note above settingsFor',
      );
    }
  }

  const withheld = KNOWN_TOOLS.filter((tool) => !profile.tools.includes(tool));
  const denyReadRules = profile.denyRead.map(readDenyRule);

  const sandbox: Record<string, unknown> =
    profile.sandbox === 'none'
      ? { enabled: false }
      : {
          enabled: true,
          // The default is `true`, and it is the hole spike 0012 reproduced: a
          // sandboxed command never reaches the permission callback.
          autoAllowBashIfSandboxed: false,
          allowUnsandboxedCommands: false,
          excludedCommands: [],
          // Stated in both directions, and it was not until this was wired into
          // the adapter. Spike 0010 measured this default depending on the
          // channel that carries it — `true` through the SDK's sandbox option,
          // `false` from a settings file — so omitting it for an `optional`
          // profile does not mean "optional": it means whatever the delivery
          // route happens to think, and through the route this adapter uses
          // that is `required`. A profile that says optional and behaves as
          // required is a session that refuses to start on a host without
          // bubblewrap, for a reason nothing in the profile explains.
          failIfUnavailable: profile.sandbox === 'required',
          ...(profile.denyRead.length > 0
            ? { filesystem: { denyRead: [...profile.denyRead] } }
            : {}),
        };

  return {
    tools: [...profile.tools],
    permissions: {
      // Kept alongside `tools`, not replaced by it. The allowlist decides what
      // exists; these bare names are a second statement of the same thing for
      // the tools this adapter knows about, and spike 0011 measured them
      // removing a tool rather than gating it. Two mechanisms saying the same
      // thing is this project's rule, not redundancy: `tools` is one option on
      // one call, and an option that stops being honoured is a silent failure
      // of exactly the kind the probe above found.
      deny: [...withheld, ...denyReadRules],
      // Deliberately empty. An allow list here would auto-approve before the
      // permission callback runs — the SDK warns about the shadowing — and a
      // decision this project makes elsewhere would stop being consulted.
      allow: [],
    },
    sandbox,
    strictMcpConfig: true,
    mcpServers: {},
    settingSources: [],
  };
}
