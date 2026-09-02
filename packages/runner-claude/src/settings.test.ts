import type { Profile } from '@cortana/policy';
import { QUARANTINE } from '@cortana/policy';
import { describe, expect, it } from 'vitest';
import { KNOWN_TOOLS, readDenyRule, settingsFor } from './settings.ts';

const WORKING: Profile = {
  name: 'working',
  trust: 'owner',
  tools: ['Read', 'Write'],
  readable: ['/var/lib/cortana'],
  writable: ['/var/lib/cortana'],
  denyRead: ['/var/lib/cortana/secrets'],
  network: 'denied',
  sandbox: 'required',
  confirm: 'never',
};

describe('the one character that decides whether a rule exists', () => {
  it('emits the rooted form', () => {
    // Spike 0011 measured both against the same target: Read(//abs/path/**)
    // holds, and Read(/abs/path/**) leaked four times out of four. The
    // difference is a slash, and the wrong one looks identical in a log.
    expect(readDenyRule('/var/lib/cortana/secrets')).toBe('Read(//var/lib/cortana/secrets/**)');
  });

  it('refuses to build a rule from a relative path', () => {
    expect(() => readDenyRule('secrets')).toThrow(/absolute/);
  });

  it('refuses a path that would produce three slashes', () => {
    // The other way to get it wrong. A rule with too many is as dead as one
    // with too few, and neither says so at runtime.
    expect(() => readDenyRule('//var/lib/cortana')).toThrow(/leading slashes/);
  });
});

describe('withholding a tool removes it', () => {
  it('denies every known tool the profile does not name', () => {
    // Spike 0011: a bare tool name in the deny list removes the tool from the
    // session entirely rather than gating it behind a callback. That is the
    // strongest lock available, and it is why the profile is an allowlist.
    const { permissions } = settingsFor(WORKING);

    for (const tool of KNOWN_TOOLS) {
      if (WORKING.tools.includes(tool)) expect(permissions.deny).not.toContain(tool);
      else expect(permissions.deny).toContain(tool);
    }
  });

  it('leaves the quarantine profile with nothing', () => {
    const { permissions } = settingsFor(QUARANTINE);

    for (const tool of KNOWN_TOOLS) expect(permissions.deny).toContain(tool);
  });

  it('never emits an allow list', () => {
    // A bare name in `allow` auto-approves before the permission callback runs —
    // the SDK warns that the callback is shadowed — so a decision this project
    // makes elsewhere would silently stop being consulted.
    expect(settingsFor(WORKING).permissions.allow).toEqual([]);
    expect(settingsFor(QUARANTINE).permissions.allow).toEqual([]);
  });
});

describe('the settings whose absence is silent', () => {
  const settings = settingsFor(WORKING);

  it('closes the Bash read channel from both sides', () => {
    // Spike 0012 found the hole reproducible and named three settings that
    // close it, none of them on by default. Two are here; the third is the deny
    // rule above.
    expect(settings.sandbox['autoAllowBashIfSandboxed']).toBe(false);
    expect(settings.sandbox['filesystem']).toEqual({ denyRead: ['/var/lib/cortana/secrets'] });
  });

  it('does not let an unsandboxable command simply run', () => {
    expect(settings.sandbox['allowUnsandboxedCommands']).toBe(false);
  });

  it('requires the sandbox when the profile says required', () => {
    // Spike 0010 measured this for the first time: without it a session whose
    // sandbox is unavailable runs anyway, uncontained and unannounced.
    expect(settings.sandbox['failIfUnavailable']).toBe(true);
  });

  it('says an optional sandbox is optional, rather than omitting the flag', () => {
    // This test used to assert the opposite — that the key was absent for an
    // optional profile — and it was right about the code and wrong about the
    // effect. Spike 0010 measured this default depending on the channel that
    // carries it: `true` through the SDK's sandbox option, `false` from a
    // settings file. The adapter uses the first, so an omitted value made
    // `optional` mean `required`, and the profile said nothing about why the
    // session would not start.
    expect(settingsFor({ ...WORKING, sandbox: 'optional' }).sandbox['failIfUnavailable']).toBe(
      false,
    );
  });

  it('refuses a profile whose network denial nothing here can enforce', () => {
    // A profile that denies the network and grants a shell has an egress path
    // and a field claiming otherwise. The sandbox has settings for it and none
    // has been measured, and an unmeasured security setting is worse than an
    // absent one because it reads as a closed door.
    expect(() => settingsFor({ ...WORKING, tools: ['Bash'], network: 'denied' })).toThrow(
      /denies the network and grants Bash/,
    );
    expect(() => settingsFor({ ...WORKING, tools: ['Bash'], network: 'allowed' })).not.toThrow();
  });

  it('inherits no MCP servers', () => {
    // Spike 0011: without both of these a session inherits whatever the
    // operator has configured — a whole tool surface nobody chose for it.
    expect(settings.strictMcpConfig).toBe(true);
    expect(settings.mcpServers).toEqual({});
  });

  it('inherits no settings files either', () => {
    // So the profile is the whole of what this session is, rather than the
    // profile plus whatever happens to be on the machine.
    expect(settings.settingSources).toEqual([]);
  });
});

describe('a profile that wants no sandbox', () => {
  it('says so plainly rather than half-configuring one', () => {
    const settings = settingsFor({ ...WORKING, sandbox: 'none' });

    expect(settings.sandbox).toEqual({ enabled: false });
  });

  it('still withholds the tools and the paths', () => {
    // Turning the sandbox off is not a way to widen a profile. Spike 0010's
    // finding is that the sandbox never constrained in-process tools anyway —
    // the deny rules are what does.
    const settings = settingsFor({ ...WORKING, sandbox: 'none' });

    expect(settings.permissions.deny).toContain('Bash');
    expect(settings.permissions.deny).toContain('Read(//var/lib/cortana/secrets/**)');
  });
});
