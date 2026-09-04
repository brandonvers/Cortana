import { describe, expect, it } from 'vitest';
import {
  decide,
  decideForSession,
  decideWithConfirmation,
  isInside,
  needsConfirmation,
} from './decide.ts';
import * as policy from './index.ts';
import { downgraded, type Profile, QUARANTINE } from './profile.ts';

const WORKING: Profile = {
  name: 'working',
  trust: 'owner',
  tools: ['Read', 'Write', 'WebFetch'],
  readable: ['/var/lib/cortana', '/etc/cortana'],
  writable: ['/var/lib/cortana'],
  denyRead: ['/var/lib/cortana/secrets'],
  network: 'allowed',
  sandbox: 'required',
  confirm: 'never',
};

describe('containment is by segment, not by prefix', () => {
  it('accepts a path inside a root', () => {
    expect(isInside('/var/lib/cortana', '/var/lib/cortana/db')).toBe(true);
    expect(isInside('/var/lib/cortana', '/var/lib/cortana')).toBe(true);
  });

  it('refuses a sibling whose name merely starts the same way', () => {
    // The bug this exists to prevent, and the kind that looks correct in every
    // example anyone writes down: /var/lib/cortana-old begins with
    // /var/lib/cortana and is a different directory.
    expect(isInside('/var/lib/cortana', '/var/lib/cortana-old/db')).toBe(false);
    expect(isInside('/var/lib/cortana', '/var/lib/cortanaX')).toBe(false);
  });

  it('handles a root written with a trailing slash', () => {
    expect(isInside('/var/lib/cortana/', '/var/lib/cortana/db')).toBe(true);
  });
});

describe('the quarantine profile', () => {
  it('has no tools at all', () => {
    // ADR-0007's disposable agent needs no capability: the content arrives in
    // its prompt and its answer is a verdict. Anything it could do beyond that
    // is a way for the content to act.
    expect(QUARANTINE.tools).toEqual([]);
  });

  it('reads nothing, writes nothing, and reaches nothing', () => {
    expect(QUARANTINE.readable).toEqual([]);
    expect(QUARANTINE.writable).toEqual([]);
    expect(QUARANTINE.network).toBe('denied');
  });

  it('will not run without a sandbox', () => {
    // Spike 0010 measured the difference this makes for the first time: without
    // it, a session whose sandbox is unavailable runs anyway.
    expect(QUARANTINE.sandbox).toBe('required');
  });

  it('refuses every call, and says which profile refused', () => {
    for (const tool of ['Read', 'Bash', 'WebFetch', 'Write']) {
      const decision = decide(QUARANTINE, { tool, path: '/etc/passwd' });
      expect(decision.verdict).toBe('deny');
      expect(decision.because).toContain('quarantine');
    }
  });
});

describe('deciding a call', () => {
  it('denies a tool the profile does not have', () => {
    expect(decide(WORKING, { tool: 'Bash' }).verdict).toBe('deny');
  });

  it('allows a read inside a readable root', () => {
    expect(decide(WORKING, { tool: 'Read', path: '/var/lib/cortana/db' }).verdict).toBe('allow');
  });

  it('denies a read outside every readable root', () => {
    const decision = decide(WORKING, { tool: 'Read', path: '/home/someone/.ssh/id_ed25519' });

    expect(decision.verdict).toBe('deny');
    expect(decision.because).toContain('/home/someone/.ssh/id_ed25519');
  });

  it('denies a write to somewhere only readable', () => {
    // Two lists rather than one, because "may look at" and "may change" are
    // different permissions and a profile that conflates them cannot express a
    // read-only configuration directory.
    expect(decide(WORKING, { tool: 'Read', path: '/etc/cortana/config.toml' }).verdict).toBe(
      'allow',
    );
    expect(
      decide(WORKING, { tool: 'Write', path: '/etc/cortana/config.toml', writes: true }).verdict,
    ).toBe('deny');
  });

  it('lets denyRead outrank readable', () => {
    // The two exist to say different things, and only the stricter survives
    // someone later widening the other.
    const decision = decide(WORKING, { tool: 'Read', path: '/var/lib/cortana/secrets/imap' });

    expect(decision.verdict).toBe('deny');
    expect(decision.because).toContain('/var/lib/cortana/secrets');
  });

  it('denies the network to a profile that does not have it', () => {
    const offline: Profile = { ...WORKING, network: 'denied' };

    expect(decide(offline, { tool: 'WebFetch', network: true }).verdict).toBe('deny');
    expect(decide(WORKING, { tool: 'WebFetch', network: true }).verdict).toBe('allow');
  });

  it('refuses a relative path rather than guessing what it means', () => {
    // It would be resolved against something this module cannot see, so every
    // containment check would be answering a question about a different file.
    const decision = decide(WORKING, { tool: 'Read', path: '../../etc/shadow' });

    expect(decision.verdict).toBe('deny');
    expect(decision.because).toContain('absolute');
  });
});

describe('asking rather than deciding', () => {
  it('turns a permitted call into a question when asked to', () => {
    const decision = decideWithConfirmation(
      WORKING,
      { tool: 'Write', path: '/var/lib/cortana/notes', writes: true },
      (request) => request.writes === true,
    );

    expect(decision.verdict).toBe('ask');
  });

  it('cannot turn a denial into a question', () => {
    // The direction that matters. Confirmation is about what happens without a
    // person; it is not a way to get past a profile by asking nicely.
    const decision = decideWithConfirmation(
      QUARANTINE,
      { tool: 'Read', path: '/etc/passwd' },
      () => true,
    );

    expect(decision.verdict).toBe('deny');
  });

  it('leaves a call alone when nothing needs confirming', () => {
    const decision = decideWithConfirmation(
      WORKING,
      { tool: 'Read', path: '/var/lib/cortana/db' },
      () => false,
    );

    expect(decision.verdict).toBe('allow');
  });
});

describe('downgrading', () => {
  it('strips a working profile to nothing', () => {
    // CONCEPTS §7.3: a session that has touched untrusted content "drops
    // irreversibly to a restricted profile for the rest of its life".
    const after = downgraded(WORKING);

    expect(after.trust).toBe('untrusted');
    expect(after.tools).toEqual([]);
    expect(after.readable).toEqual([]);
    expect(after.network).toBe('denied');
    expect(after.sandbox).toBe('required');
  });

  it('keeps the name of what it was, so an audit can say', () => {
    expect(downgraded(WORKING).name).toBe('working+untrusted');
  });

  it('is the only direction this package offers', () => {
    // There is deliberately no function that raises trust, and an absence is
    // exactly what a later contributor adds without noticing it was a decision.
    // So the assertion is about the package's surface rather than about a
    // behaviour: nothing exported may sound like it restores trust.
    const raising = Object.keys(policy).filter((name) =>
      /restore|upgrade|elevate|trust/i.test(name),
    );

    expect(raising).toEqual([]);
  });

  it('stays at the bottom when applied twice', () => {
    expect(downgraded(downgraded(WORKING)).trust).toBe('untrusted');
  });
});

describe('which permitted calls still need a person', () => {
  const asks = (confirm: Profile['confirm']) => needsConfirmation({ ...WORKING, confirm });

  it('asks about nothing when the profile says never', () => {
    expect(asks('never')({ tool: 'Write', writes: true })).toBe(false);
  });

  it('asks about everything when the profile says always', () => {
    expect(asks('always')({ tool: 'Read' })).toBe(true);
  });

  it('treats a write and an egress as the same question', () => {
    // From an operator's point of view "it changed something" and "it left the
    // machine" are one question — is this irreversible? — and a profile that
    // asked about one and not the other would be answering half of it.
    const writes = asks('writes');

    expect(writes({ tool: 'Write', writes: true })).toBe(true);
    expect(writes({ tool: 'WebFetch', network: true })).toBe(true);
    expect(writes({ tool: 'Read', writes: false, network: false })).toBe(false);
  });
});

describe('the decision a session actually uses', () => {
  it("is the boundary and the profile's own answer about people, together", () => {
    const profile: Profile = { ...WORKING, confirm: 'writes' };

    expect(decideForSession(profile, { tool: 'Read', path: '/etc/cortana/a' }).verdict).toBe(
      'allow',
    );
    expect(
      decideForSession(profile, { tool: 'Write', path: '/var/lib/cortana/a', writes: true })
        .verdict,
    ).toBe('ask');
  });

  it('cannot turn a refusal into a question, in either direction', () => {
    // There would be nothing to ask about. A profile that permits nothing is not
    // made consultable by asking it to be.
    const profile: Profile = { ...WORKING, confirm: 'always' };

    expect(decideForSession(profile, { tool: 'Bash' }).verdict).toBe('deny');
  });

  it('never asks on behalf of a session holding untrusted content', () => {
    // A question is text an operator reads and acts on. A quarantine session is
    // holding content nobody here wrote, and letting it reach the approval path
    // would hand that content a sentence to compose.
    expect(QUARANTINE.confirm).toBe('never');
    expect(downgraded({ ...WORKING, confirm: 'always' }).confirm).toBe('never');
  });
});
