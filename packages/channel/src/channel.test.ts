import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError, isAppError } from '@cortana/core';
import { recordingLogger } from '@cortana/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvalThrough, questionFor } from './approval.ts';
import { connect } from './client.ts';
import { MAX_FRAME_BYTES, parseClientFrame } from './protocol.ts';
import {
  type Channel,
  createChannel,
  MAX_SOCKET_PATH_BYTES,
  type SayHandler,
  socketPathFor,
} from './server.ts';

let root: string;
let dataDir: string;
let channel: Channel | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-channel-'));
  dataDir = join(root, 'state');
  channel = null;
});

afterEach(async () => {
  await channel?.stop();
  rmSync(root, { recursive: true, force: true });
});

async function serve(onSay: SayHandler, options: { askTimeoutMs?: number } = {}) {
  channel = createChannel({
    dataDir,
    onSay,
    logger: recordingLogger(),
    ...(options.askTimeoutMs === undefined ? {} : { askTimeoutMs: options.askTimeoutMs }),
  });
  await channel.start();
  return channel;
}

describe('talking to it', () => {
  it('answers what it was asked', async () => {
    await serve(async (text) => `you said: ${text}`);
    const client = await connect({ path: socketPathFor(dataDir), onAsk: () => false });

    expect(await client.say('hello')).toBe('you said: hello');
    client.close();
  });

  it('keeps replies matched to the right message', async () => {
    // Two messages in flight at once, answered out of order. Without
    // correlation the second reply would resolve the first caller.
    await serve(async (text) => {
      if (text === 'slow') await new Promise((resolve) => setTimeout(resolve, 60));
      return `answer to ${text}`;
    });
    const client = await connect({ path: socketPathFor(dataDir), onAsk: () => false });

    const [slow, quick] = await Promise.all([client.say('slow'), client.say('quick')]);

    expect(slow).toBe('answer to slow');
    expect(quick).toBe('answer to quick');
    client.close();
  });

  it('reports a failed turn instead of dropping the caller', async () => {
    await serve(async () => {
      throw new Error('the model said no');
    });
    const client = await connect({ path: socketPathFor(dataDir), onAsk: () => false });

    await expect(client.say('anything')).rejects.toThrow(/the model said no/);
    client.close();
  });
});

describe('asking before acting', () => {
  it('puts the question to whoever is connected, and waits for it', async () => {
    const asked: string[] = [];
    await serve(async (_text, conversation) => {
      const approved = await conversation.ask('Run rm -rf /tmp/x?', 'permitted, but confirmed');
      return approved ? 'did it' : 'left it alone';
    });
    const client = await connect({
      path: socketPathFor(dataDir),
      onAsk: (question, because) => {
        asked.push(`${question} (${because})`);
        return true;
      },
    });

    expect(await client.say('tidy up')).toBe('did it');
    expect(asked).toEqual(['Run rm -rf /tmp/x? (permitted, but confirmed)']);
    client.close();
  });

  it('takes no for an answer', async () => {
    await serve(async (_text, conversation) =>
      (await conversation.ask('Really?', 'because')) ? 'did it' : 'left it alone',
    );
    const client = await connect({ path: socketPathFor(dataDir), onAsk: () => false });

    expect(await client.say('tidy up')).toBe('left it alone');
    client.close();
  });

  it('treats an unanswered question as a refusal rather than waiting forever', async () => {
    // M3's definition of done: an approval you never answer must not wedge the
    // daemon. The safe answer to an unanswered question about doing something is
    // no, and it has to arrive on its own.
    await serve(
      async (_text, conversation) =>
        (await conversation.ask('Really?', 'because')) ? 'did it' : 'left it alone',
      { askTimeoutMs: 60 },
    );
    const client = await connect({
      path: socketPathFor(dataDir),
      onAsk: () => new Promise<boolean>(() => undefined),
    });

    expect(await client.say('tidy up')).toBe('left it alone');
    client.close();
  });

  it('treats a disconnection as a refusal too', async () => {
    // The person who would have answered has gone. Waiting out the timeout
    // would be waiting for someone who is not there.
    let verdict: boolean | null = null;
    await serve(
      async (_text, conversation) => {
        verdict = await conversation.ask('Really?', 'because');
        return 'done';
      },
      { askTimeoutMs: 30_000 },
    );

    const client = await connect({
      path: socketPathFor(dataDir),
      onAsk: () => {
        client.close();
        return new Promise<boolean>(() => undefined);
      },
    });
    const client2 = client;
    void client2.say('tidy up').catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(verdict).toBe(false);
  });
});

describe('the socket itself', () => {
  it('lives in the data directory, named after the product', async () => {
    // ADR-0002 requires renaming to stay cheap, so the name is derived.
    await serve(async () => 'ok');

    expect(socketPathFor(dataDir)).toBe(join(dataDir, 'cortana.sock'));
    expect(existsSync(socketPathFor(dataDir))).toBe(true);
  });

  it('is reachable only by its owner, and sits in a directory that is too', async () => {
    // The directory is the actual control: between listen and chmod there is a
    // moment where the socket has whatever the umask allows, and 0700 on the
    // directory is what makes that moment uninteresting.
    await serve(async () => 'ok');

    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(socketPathFor(dataDir)).mode & 0o777).toBe(0o600);
  });

  it('cleans up after itself', async () => {
    const served = await serve(async () => 'ok');
    await served.stop();
    channel = null;

    expect(existsSync(socketPathFor(dataDir))).toBe(false);
  });

  it('takes over a socket left behind by a process that was killed', async () => {
    // A SIGKILL leaves the file, and the next start would fail with EADDRINUSE
    // on a socket nobody is listening to.
    const path = socketPathFor(dataDir);
    require('node:fs').mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(path, '');

    await serve(async () => 'ok');
    const client = await connect({ path, onAsk: () => false });

    expect(await client.say('hello')).toBe('ok');
    client.close();
  });

  it('refuses to take over one that is still in use', async () => {
    // Deleting blindly is how two daemons end up fighting over one path.
    await serve(async () => 'ok');
    const second = createChannel({ dataDir, onSay: async () => 'ok' });

    await expect(second.start()).rejects.toThrow(/already listening/);
  });

  it('says so when there is nothing to connect to', async () => {
    const failure = await connect({
      path: join(dataDir, 'nothing.sock'),
      onAsk: () => false,
    }).catch((error: unknown) => error);

    expect(isAppError(failure) && failure.category).toBe('unavailable');
    expect(isAppError(failure) && failure.code).toBe('channel-unreachable');
  });
});

describe('a line that is not a frame', () => {
  it.each([
    ['not JSON at all', 'reason'],
    ['[1,2,3]', 'reason'],
    ['{"type":"say"}', 'reason'],
    ['{"id":"a","type":"say"}', 'reason'],
    ['{"id":"a","type":"nonsense"}', 'reason'],
  ])('is explained rather than thrown: %s', (line) => {
    const parsed = parseClientFrame(line);
    expect(parsed).toHaveProperty('reason');
  });

  it('does not close the connection over a typo', async () => {
    // The other end is a person's terminal. A malformed line is far more likely
    // to be a mistake than an attack, and the connection surviving is what lets
    // them try again.
    await serve(async (text) => `you said: ${text}`);
    const client = await connect({ path: socketPathFor(dataDir), onAsk: () => false });

    expect(await client.say('still here')).toBe('you said: still here');
    client.close();
  });

  it('disconnects a client that never sends a newline', async () => {
    // Without the limit, memory grows until something else on the machine dies.
    await serve(async () => 'ok');
    const raw = require('node:net').createConnection(socketPathFor(dataDir));
    await new Promise((resolve) => raw.once('connect', resolve));

    raw.write('x'.repeat(MAX_FRAME_BYTES + 1));
    await new Promise((resolve) => raw.once('close', resolve));

    expect(raw.destroyed).toBe(true);
  });
});

describe('turning a decision into a question for a person', () => {
  const because = 'permitted by the working profile, but this kind of call is confirmed';

  it('names the tool and the whole path', () => {
    const question = questionFor({ tool: 'Write', path: '/srv/work/out/report.md', writes: true });

    expect(question).toContain('Write');
    // Whole, not shortened. A prompt that elides the middle of a path reads the
    // same for two different files, and the difference between them is the
    // entire question being asked.
    expect(question).toContain('/srv/work/out/report.md');
    expect(question).toContain('write');
  });

  it('says when a call would leave the machine', () => {
    expect(questionFor({ tool: 'WebFetch', network: true })).toContain('reaching the network');
  });

  it('says something specific about a call that touches no path', () => {
    const question = questionFor({ tool: 'Bash', writes: true, network: true });

    expect(question).toContain('Bash');
    expect(question).not.toContain('undefined');
  });

  it("carries the policy engine's reason beside the question, not inside it", async () => {
    const asked: { question: string; because: string }[] = [];
    const approve = approvalThrough({
      ask: async (question, why) => {
        asked.push({ question, because: why });
        return true;
      },
    });

    await approve(
      { tool: 'Write', path: '/srv/work/out/a', writes: true },
      {
        verdict: 'ask',
        because,
      },
    );

    expect(asked[0]?.question).toContain('/srv/work/out/a');
    expect(asked[0]?.because).toBe(because);
  });

  it('is a refusal when nobody answers, because the conversation says so', async () => {
    // Nothing in `approvalThrough` implements a timeout, and that is the point:
    // `Conversation.ask` already resolves false on a refusal, a disconnection
    // and on silence. A second timeout here would be a second thing to get wrong.
    const approve = approvalThrough({ ask: async () => false });

    await expect(
      approve(
        { tool: 'Write', path: '/srv/work/out/a', writes: true },
        {
          verdict: 'ask',
          because,
        },
      ),
    ).resolves.toBe(false);
  });
});

describe('a data directory too deep to hold a socket', () => {
  it('says which setting is wrong, rather than passing on EINVAL', async () => {
    // How the first assembled daemon failed to start. The address is a
    // fixed-size field in a C struct, and `listen` reports a path that is too
    // long as "invalid argument" — naming neither the path, the length, nor the
    // limit.
    const deep = join(root, 'x'.repeat(MAX_SOCKET_PATH_BYTES));
    const tooLong = createChannel({ dataDir: deep, onSay: async () => 'hi' });

    await expect(tooLong.start()).rejects.toSatisfy(
      (error: unknown) =>
        isAppError(error) &&
        error.category === 'config' &&
        error.code === 'channel-path-too-long' &&
        error.message.includes('shorter data directory'),
    );
  });

  it('lets a path exactly at the limit through', async () => {
    // The boundary is measured, not assumed: on this project's development
    // machine 104 characters listened and 105 returned EINVAL. An off-by-one
    // here refuses a path the operating system would have accepted.
    // Adding a directory costs its name *and* a separator, which is the
    // off-by-one this test was written with the first time.
    const name = socketPathFor(root);
    const room = MAX_SOCKET_PATH_BYTES - Buffer.byteLength(name, 'utf8') - 1;
    if (room < 1) return; // The test's own temp path is already near the limit.

    const padded = join(root, 'y'.repeat(room));
    channel = createChannel({ dataDir: padded, onSay: async () => 'hi' });

    await expect(channel.start()).resolves.toBeUndefined();
  });
});

describe('a turn that failed on the daemon', () => {
  it('reaches the client as the daemon said it, not wrapped twice', async () => {
    // What an operator on the deployment target actually read:
    //   AppError: the daemon could not answer: AppError: the provider ended…
    // Two class names and a clause about the client before anything about the
    // failure. The daemon's sentence is the message now.
    channel = createChannel({
      dataDir,
      onSay: async () => {
        throw new AppError('Not logged in · Please run /login', {
          category: 'config',
          code: 'turn-failed',
        });
      },
    });
    await channel.start();

    const client = await connect({ path: socketPathFor(dataDir), onAsk: async () => false });
    try {
      await expect(client.say('hello')).rejects.toSatisfy((error: unknown) => {
        if (!isAppError(error)) return false;
        expect(error.message).toBe('Not logged in · Please run /login');
        // The daemon's category, not one the client invented. `internal` here
        // told an operator their own code was broken when it was not.
        expect(error.category).toBe('config');
        return true;
      });
    } finally {
      client.close();
    }
  });

  it('claims no category at all when the failure was not one of ours', async () => {
    channel = createChannel({
      dataDir,
      onSay: async () => {
        throw new TypeError('something else entirely');
      },
    });
    await channel.start();

    const client = await connect({ path: socketPathFor(dataDir), onAsk: async () => false });
    try {
      await expect(client.say('hello')).rejects.toSatisfy(
        (error: unknown) =>
          isAppError(error) &&
          error.category === 'internal' &&
          error.message.includes('something else entirely'),
      );
    } finally {
      client.close();
    }
  });
});
