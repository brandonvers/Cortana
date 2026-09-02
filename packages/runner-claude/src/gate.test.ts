import { recordingLogger } from '@cortana/core/testing';
import { type Profile, QUARANTINE } from '@cortana/policy';
import { describe, expect, it } from 'vitest';
import { createGate } from './gate.ts';
import { requestFor } from './tools.ts';

const READER: Profile = {
  name: 'reader',
  trust: 'system',
  tools: ['Read', 'Write'],
  readable: ['/srv/work'],
  writable: ['/srv/work/out'],
  denyRead: ['/srv/work/secrets'],
  network: 'allowed',
  sandbox: 'required',
  confirm: 'never',
};

const gateFor = (profile: Profile, over: Record<string, unknown> = {}) =>
  createGate({ profile, session: 's', ...over });

describe('what a provider tool call means', () => {
  it('reads the path out of the key that tool actually uses', () => {
    // Each of these was read from the tool's own input schema. A wrong key
    // produces a request with no path, which is decided on the tool name alone
    // — no error, nothing odd in a log, and no path check.
    expect(requestFor('Read', { file_path: '/a' })).toMatchObject({ path: '/a', writes: false });
    expect(requestFor('Grep', { path: '/b', pattern: 'x' })).toMatchObject({ path: '/b' });
    expect(requestFor('NotebookEdit', { notebook_path: '/c' })).toMatchObject({
      path: '/c',
      writes: true,
    });
  });

  it('treats a shell as both a write and an egress path', () => {
    // Which one a given command is cannot be known without parsing it, and
    // deciding security by parsing shell is a well-travelled way to be wrong.
    expect(requestFor('Bash', { command: 'ls' })).toMatchObject({ writes: true, network: true });
  });

  it('gives a tool it has never heard of a name and nothing else', () => {
    // Which is enough: a profile is an allowlist, so an unnamed tool is refused
    // without this file needing a branch for it.
    expect(requestFor('ToolSearch', { query: 'x' })).toEqual({ tool: 'ToolSearch' });
  });
});

describe('the gate', () => {
  it('refuses a tool the profile does not name, whatever it is called', async () => {
    // On 2026-09-02 a session under QUARANTINE called ToolSearch and it
    // succeeded, because withholding by name only reaches names this repository
    // knows. This is the shape that does not depend on knowing the name.
    const outcome = await gateFor(QUARANTINE)('ToolSearch', { query: 'select:Read' });

    expect(outcome.allow).toBe(false);
  });

  it('refuses a path outside what the profile can read', async () => {
    const gate = gateFor(READER);

    expect((await gate('Read', { file_path: '/srv/work/notes.md' })).allow).toBe(true);
    expect((await gate('Read', { file_path: '/etc/shadow' })).allow).toBe(false);
  });

  it('refuses a denied path even where the profile can otherwise read', async () => {
    const outcome = await gateFor(READER)('Read', { file_path: '/srv/work/secrets/key' });

    expect(outcome.allow).toBe(false);
  });

  it('lets the provider finish a structured turn', async () => {
    // The carrier is the provider's own end-turn machinery. Refusing it contains
    // nothing and breaks the mechanism ADR-0015 requires at this exact boundary.
    const outcome = await gateFor(QUARANTINE)('StructuredOutput', { value: {} });

    expect(outcome.allow).toBe(true);
  });
});

describe('a call the profile will not decide alone', () => {
  const CONFIRMING: Profile = { ...READER, confirm: 'writes' };

  it('is put to whoever is there, and allowed when they say yes', async () => {
    const asked: string[] = [];
    const gate = gateFor(CONFIRMING, {
      approve: async (request: { tool: string }) => {
        asked.push(request.tool);
        return true;
      },
    });

    expect((await gate('Write', { file_path: '/srv/work/out/a' })).allow).toBe(true);
    expect(asked).toEqual(['Write']);
  });

  it('is refused when they say no', async () => {
    const gate = gateFor(CONFIRMING, { approve: async () => false });

    expect((await gate('Write', { file_path: '/srv/work/out/a' })).allow).toBe(false);
  });

  it('is refused when there is nobody to ask', async () => {
    // The direction matters: a missing wiring must produce refusals in the log,
    // not calls that quietly ran because no one was watching.
    const logger = recordingLogger();
    const outcome = await gateFor(CONFIRMING, { logger })('Write', {
      file_path: '/srv/work/out/a',
    });

    expect(outcome.allow).toBe(false);
    expect(logger.text()).toContain('nobody to ask');
  });

  it('is not asked about at all when the profile says never', async () => {
    let asked = false;
    const gate = gateFor(READER, {
      approve: async () => {
        asked = true;
        return false;
      },
    });

    expect((await gate('Write', { file_path: '/srv/work/out/a' })).allow).toBe(true);
    expect(asked).toBe(false);
  });

  it('is never reached by a profile that permits nothing', async () => {
    // QUARANTINE sets `confirm: 'never'` and that reads backwards for the
    // strictest profile in the system. A question is text a person acts on, and
    // an untrusted session must not be able to compose one.
    let asked = false;
    const gate = gateFor(QUARANTINE, {
      approve: async () => {
        asked = true;
        return true;
      },
    });

    expect((await gate('Read', { file_path: '/etc/shadow' })).allow).toBe(false);
    expect(asked).toBe(false);
  });
});

describe('when the gate itself is broken', () => {
  it('refuses, rather than letting the provider decide what a failure means', async () => {
    const logger = recordingLogger();
    const gate = createGate({
      profile: { ...READER, confirm: 'always' },
      session: 's',
      logger,
      approve: async () => {
        throw new Error('the socket went away mid-question');
      },
    });

    const outcome = await gate('Read', { file_path: '/srv/work/notes.md' });

    expect(outcome.allow).toBe(false);
    expect(outcome.because).toContain('could not decide');
    expect(logger.text()).toContain('deciding a tool call failed');
  });
});
