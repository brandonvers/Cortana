import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditTurns } from '@cortana/audit';
import { connect, socketPathFor } from '@cortana/channel';
import { MODEL_TIERS as CONFIGURABLE_TIERS, type Config } from '@cortana/config';
import { recordingLogger } from '@cortana/core/testing';
import { MODEL_TIERS } from '@cortana/runner';
import { fakeRunner } from '@cortana/runner/testing';
import { desc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningKernel, startKernel } from './kernel.ts';

let root: string;
let config: Config;
let kernel: RunningKernel | null;

const answer = (reply: string, actions: unknown[] = []) => ({ reply, actions });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-talk-'));
  kernel = null;
  config = {
    dataDir: join(root, 'state'),
    log: { level: 'error' },
    audit: { retentionDays: 90 },
    agent: {
      persona: 'You are Cortana.',
      tier: 'balanced',
      tools: [],
      readable: [],
      writable: [],
      confirm: 'writes',
    },
    shutdown: { timeoutMs: 5_000 },
  };
});

afterEach(async () => {
  await kernel?.stop('test over');
  rmSync(root, { recursive: true, force: true });
});

const start = async (values: unknown[] = [answer('hello')], over: Partial<Config> = {}) => {
  const runner = fakeRunner({ values });
  kernel = await startKernel({
    config: { ...config, ...over },
    logger: recordingLogger(),
    version: '0.3.0',
    openRunner: async () => runner,
  });
  return { runner, kernel };
};

type Ask = (question: string, because: string) => Promise<boolean>;

const say = async (text: string, onAsk: Ask = async () => false): Promise<string> => {
  const client = await connect({ path: socketPathFor(config.dataDir), onAsk });
  try {
    return await client.say(text);
  } finally {
    client.close();
  }
};

describe('talking to it', () => {
  it('answers over the socket', async () => {
    await start([answer('seven is prime')]);

    expect(await say('is seven prime?')).toBe('seven is prime');
  });

  it('remembers the conversation within a session', async () => {
    // "Remembers" here means one session across turns, which is all M3 claims:
    // memory that outlives a session is M5, and is blocked on a corpus.
    const { runner } = await start([answer('first'), answer('second')]);

    await say('one');
    await say('two');

    expect(runner.sessions).toBe(1);
    expect(runner.turns.map((turn) => turn.prompt)).toEqual(['one', 'two']);
  });
});

describe('when nobody has said anything yet', () => {
  it('has opened no session at all', async () => {
    // Spike 0003 priced an idle session at 263 MB and a cold start at 5.4–6.2 s,
    // and CONCEPTS §3.3 makes dormancy the default. A daemon nobody has spoken
    // to holds a socket and a database.
    const { runner, kernel: running } = await start();

    expect(runner.sessions).toBe(0);
    expect(running.agent()).toBeNull();
  });

  it('reports itself healthy anyway, and says it is dormant', async () => {
    const { kernel: running } = await start();

    const report = await running.health();
    const agent = report.components.find((component) => component.name === 'agent');

    expect(report.status).toBe('ok');
    expect(agent?.health.detail).toBe('dormant');
  });

  it('opens exactly one session when two people speak at once', async () => {
    // Both find no agent in the same tick. Storing the promise rather than the
    // result is what stops that opening two sessions and keeping the second.
    const { runner } = await start([answer('a'), answer('b')]);

    await Promise.all([say('one'), say('two')]);

    expect(runner.sessions).toBe(1);
  });
});

describe('with no provider installed', () => {
  it('still starts, and still records, and still stops cleanly', async () => {
    // ADR-0020 makes the SDK an optional peer. A daemon that refused to start
    // without it would refuse to do everything it can do without it.
    kernel = await startKernel({ config, logger: recordingLogger(), version: '0.3.0' });

    const report = await kernel.health();

    expect(report.status).toBe('ok');
  });

  it('says so on the socket, where the person actually is', async () => {
    kernel = await startKernel({ config, logger: recordingLogger(), version: '0.3.0' });

    const reply = await say('hello?');

    // Not a stack trace and not a silence: the operator is at a terminal, and
    // this is the one failure they can fix themselves.
    expect(reply).toContain('no model provider is configured');
  });

  it('does not wedge the daemon, so the next message is still served', async () => {
    kernel = await startKernel({ config, logger: recordingLogger(), version: '0.3.0' });

    await say('hello?');

    expect(await say('still there?')).toContain('no model provider is configured');
  });
});

describe('when opening the agent fails', () => {
  it('tries again on the next message, rather than failing forever', async () => {
    // The promise is stored so two messages in one tick share one session. Not
    // clearing it on failure turns one bad start into a permanent one: every
    // later message awaits the same rejection, and the daemon never retries
    // something that may have been transient.
    let attempts = 0;
    const runner = fakeRunner({ values: [answer('working now')] });
    kernel = await startKernel({
      config,
      logger: recordingLogger(),
      version: '0.3.0',
      openRunner: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('the provider was briefly unreachable');
        return runner;
      },
    });

    await expect(say('first')).rejects.toThrow();
    expect(await say('second')).toBe('working now');
    expect(attempts).toBe(2);
  });
});

describe('what a conversation leaves behind', () => {
  it('is in the audit before the reply is handed over', async () => {
    // ADR-0019, and the reason the runner is wrapped rather than trusted to
    // record itself: a turn the caller acted on is a turn the database knows.
    const { kernel: running } = await start([answer('an answer')]);

    await say('a question');

    const rows = running.storage.db.select().from(auditTurns).orderBy(desc(auditTurns.id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.prompt).toBe('a question');
    expect(rows[0]?.instanceId).toBe(running.instanceId);
  });

  it('survives the daemon stopping and starting again', async () => {
    // The definition of done, end to end: what was said is in the audit, and
    // the socket comes back.
    const first = await start([answer('before')]);
    await say('said before the restart');
    await first.kernel.stop('restarting');

    const second = await start([answer('after')]);
    kernel = second.kernel;

    expect(await say('said after the restart')).toBe('after');
    const rows = second.kernel.storage.db.select().from(auditTurns).all();
    expect(rows.map((row) => row.prompt)).toContain('said before the restart');
    // Two runs, two instance ids, one audit.
    expect(new Set(rows.map((row) => row.instanceId)).size).toBe(2);
  });
});

describe('stopping', () => {
  it('closes the session, so a stopped daemon is not holding one', async () => {
    const { kernel: running } = await start([answer('hello')]);
    await say('wake up');
    const agent = running.agent();

    await running.stop('done');
    kernel = null;

    expect(agent?.stopped).toBe(true);
  });

  it('frees the socket, so the next run can take it', async () => {
    const first = await start();
    await first.kernel.stop('done');

    // The channel connects before unlinking, so a live socket is never removed
    // and a dead one never blocks a start. This is that, through the kernel.
    const second = await start();
    kernel = second.kernel;

    expect(await say('anyone there?')).toBe('hello');
  });
});

describe('a decision the policy engine will not make on its own', () => {
  const WITH_TOOLS: Partial<Config> = {
    agent: {
      persona: 'You are Cortana.',
      tier: 'balanced',
      tools: ['Write'],
      readable: ['/srv/work'],
      writable: ['/srv/work'],
      confirm: 'writes',
    },
  };

  const wantsToWrite = () => ({
    reply: 'Writing it now.',
    actions: [
      {
        tool: 'Write',
        path: '/srv/work/report.md',
        writes: true,
        network: false,
        why: 'to save the report',
      },
    ],
  });

  it('is put to whoever is on the socket, naming the call', async () => {
    await start([wantsToWrite()], WITH_TOOLS);
    const asked: string[] = [];

    await say('write the report', async (question: string) => {
      asked.push(question);
      return true;
    });

    expect(asked).toHaveLength(1);
    // Built from the tool and the path, never from the agent's own sentence.
    expect(asked[0]).toContain('Write');
    expect(asked[0]).toContain('/srv/work/report.md');
    expect(asked[0]).not.toContain('to save the report');
  });

  it('reaches the person who caused it, not whoever connected first', async () => {
    // The agent outlives the connections to it, and a session's own approver is
    // fixed when the session opens. The first connection wakes the agent; the
    // second is the one that must be asked.
    await start([{ reply: 'ok', actions: [] }, wantsToWrite()], WITH_TOOLS);

    let firstWasAsked = false;
    await say('hello', async () => {
      firstWasAsked = true;
      return true;
    });

    let secondWasAsked = false;
    await say('write the report', async () => {
      secondWasAsked = true;
      return true;
    });

    expect(firstWasAsked).toBe(false);
    expect(secondWasAsked).toBe(true);
  });

  it('is a refusal when the person says no', async () => {
    const { runner } = await start([wantsToWrite(), answer('understood')], WITH_TOOLS);

    await say('write the report', async () => false);
    await say('why not?');

    // The refusal is carried into the next turn's prompt, so the agent knows.
    expect(runner.turns[1]?.prompt).toContain('refused by the operator');
  });
});

describe('the tiers configuration accepts', () => {
  it('are exactly the tiers the port has', () => {
    // `@cortana/config` repeats this list rather than importing it, so that the
    // package every other one reads its settings through holds no edge that
    // could pull a provider in behind it. This is the test that comment
    // promises, and it lives here because the kernel already depends on both.
    expect([...CONFIGURABLE_TIERS]).toEqual([...MODEL_TIERS]);
  });
});
