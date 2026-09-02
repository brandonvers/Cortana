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
 */
export function settingsFor(profile: Profile): ProviderSettings {
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
          ...(profile.sandbox === 'required' ? { failIfUnavailable: true } : {}),
          ...(profile.denyRead.length > 0
            ? { filesystem: { denyRead: [...profile.denyRead] } }
            : {}),
        };

  return {
    permissions: {
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
