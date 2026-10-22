import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, socketPathFor } from '@cortana/channel';
import type { Config } from '@cortana/config';
import { recordingLogger } from '@cortana/core/testing';
import { fakeRunner } from '@cortana/runner/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type KernelAction, MAX_ACTION_ROUNDS } from './actions.ts';
import { type RunningKernel, startKernel } from './kernel.ts';

let root: string;
let config: Config;
let kernel: RunningKernel | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-act-'));
  kernel = null;
  config = {
    dataDir: join(root, 'state'),
    log: { level: 'error' },
    language: 'en',
    audit: { retentionDays: 90 },
    agent: {
      persona: 'You are Cortana.',
      tier: 'balanced',
      tools: [],
      actions: ['stamp'],
      readable: [],
      writable: [],
      confirm: 'writes',
    },
    roster: { directory: '/etc/cortana/agents', idleTtlMs: 300_000, maxAwake: 4 },
    shutdown: { timeoutMs: 5_000 },
  };
});

afterEach(async () => {
  await kernel?.stop('test over');
  rmSync(root, { recursive: true, force: true });
});

/** A JPEG as far as the store is concerned. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);

/** An action that keeps a file and says so, and remembers what it was given. */
function stamp(options: { writes?: boolean; fails?: Error } = {}) {
  const given: unknown[] = [];
  const action: KernelAction<{ label: string }> = {
    name: 'stamp',
    description: 'makes a picture with a label',
    input: '{"label":"…"}',
    writes: options.writes ?? false,
    network: false,
    schema: z.object({ label: z.string().min(1) }),
    async run(input, context) {
      given.push(input);
      if (options.fails) throw options.fails;
      const held = context.store.put(JPEG);
      return { summary: `made a picture labelled ${input.label}`, files: [held.id] };
    },
  };
  return { action: action as KernelAction, given };
}

const asking = (input: string, reply = 'Making it.') => ({
  reply,
  actions: [{ tool: 'stamp', path: null, writes: false, network: false, why: 'to make it', input }],
});
const answer = (reply: string) => ({ reply, actions: [] });

async function run(values: unknown[], action: KernelAction, over: Partial<Config['agent']> = {}) {
  const runner = fakeRunner({ values });
  kernel = await startKernel({
    config: { ...config, agent: { ...config.agent, ...over } },
    logger: recordingLogger(),
    version: '0.4.0',
    openRunner: async () => runner,
    actions: [action],
  });
  return runner;
}

const say = async (
  text: string,
  onAsk: (question: string, because: string) => Promise<boolean> = async () => false,
): Promise<string> => {
  const client = await connect({ path: socketPathFor(config.dataDir), onAsk });
  try {
    return await client.say(text);
  } finally {
    client.close();
  }
};

describe('an action the agent asks for', () => {
  it('runs, and the agent is told how it went, and what it made is sent', async () => {
    const { action, given } = stamp();
    const runner = await run([asking('{"label":"cover"}'), answer('Here it is.')], action);

    const reply = await say('make me a cover');

    expect(given).toEqual([{ label: 'cover' }]);
    expect(runner.turns[1]?.prompt).toContain('- stamp: done — made a picture labelled cover');
    // Sent although the agent did not attach it: the person asked for the
    // picture, not for the agent to remember its id.
    expect(reply).toMatch(/^Here it is\.\n\[attached: [0-9a-f]{16} \(image\/jpeg/);
  });

  it('does not run when the configuration does not offer it', async () => {
    const { action, given } = stamp();
    await run([asking('{"label":"cover"}')], action, { actions: [] });

    expect(await say('make me a cover')).toBe('Making it.');
    expect(given).toEqual([]);
  });

  it('does not run on input that does not fit, and the agent is told why', async () => {
    const { action, given } = stamp();
    const runner = await run([asking('{"label":5}'), answer('Sorry.')], action);

    await say('make me a cover');

    expect(given).toEqual([]);
    expect(runner.turns[1]?.prompt).toContain('stamp: not done — its input did not fit at label');
  });

  it('is handed only what its schema accepted, not what the model added', async () => {
    // The schema drops a field it does not declare. The action must see the
    // checked value, or the check decided nothing about what actually runs.
    const { action, given } = stamp();
    await run([asking('{"label":"cover","path":"/etc/shadow"}'), answer('Done.')], action);

    await say('make me a cover');

    expect(given).toEqual([{ label: 'cover' }]);
  });

  it('does not run on input that is not JSON at all', async () => {
    const { action, given } = stamp();
    const runner = await run([asking('label: cover'), answer('Sorry.')], action);

    await say('make me a cover');

    expect(given).toEqual([]);
    expect(runner.turns[1]?.prompt).toContain('its input was not JSON');
  });

  it('comes back as a sentence when it throws, and never as the error', async () => {
    const { action } = stamp({ fails: new Error('EACCES: /var/lib/cortana/secret') });
    const runner = await run([asking('{"label":"cover"}'), answer('It did not work.')], action);

    expect(await say('make me a cover')).toBe('It did not work.');
    expect(runner.turns[1]?.prompt).toContain('it failed, and the details are in the log');
    expect(runner.turns[1]?.prompt).not.toContain('EACCES');
  });

  it('runs at most a bounded number of times for one message', async () => {
    const { action, given } = stamp();
    // An agent that asks again every time it is told.
    await run(
      Array.from({ length: MAX_ACTION_ROUNDS + 2 }, () => asking('{"label":"again"}', 'Again.')),
      action,
    );

    expect(await say('loop')).toMatch(/^Again\./);
    expect(given).toHaveLength(MAX_ACTION_ROUNDS);
  });
});

describe('an action that writes, under a profile that confirms writes', () => {
  it('is put to the person, and does not run on a no', async () => {
    const { action, given } = stamp({ writes: true });
    await run([asking('{"label":"cover"}')], action);
    const asked: string[] = [];

    await say('make me a cover', async (question: string) => {
      asked.push(question);
      return false;
    });

    expect(asked[0]).toContain('stamp');
    expect(given).toEqual([]);
  });

  it('runs on a yes', async () => {
    const { action, given } = stamp({ writes: true });
    await run([asking('{"label":"cover"}'), answer('Done.')], action);

    await say('make me a cover', async () => true);

    expect(given).toEqual([{ label: 'cover' }]);
  });
});
