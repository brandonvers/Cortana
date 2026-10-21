import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, socketPathFor } from '@cortana/channel';
import { type Config, Secret } from '@cortana/config';
import { AppError, isAppError } from '@cortana/core';
import { recordingLogger } from '@cortana/core/testing';
import { IMAGE_TYPES } from '@cortana/media';
import { TURN_IMAGE_TYPES } from '@cortana/runner';
import { fakeRunner } from '@cortana/runner/testing';
import {
  createTelegramChannel,
  type TelegramChannel,
  type TelegramOptions,
  type TelegramResponse,
} from '@cortana/telegram';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TELEGRAM_TOKEN } from './conversation.ts';
import { type KernelOptions, type RunningKernel, startKernel } from './kernel.ts';

const OWNER = 1001;
const BOT = {
  id: 42,
  is_bot: true,
  first_name: 'Cortana',
  username: 'cortana_test_bot',
} as unknown as NonNullable<TelegramOptions['botInfo']>;

let root: string;
let config: Config;
let kernel: RunningKernel | null;

const answer = (reply: string) => ({ reply, actions: [] });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-tg-'));
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
    roster: { directory: '/etc/cortana/agents', idleTtlMs: 300_000, maxAwake: 4 },
    telegram: { allowedUserIds: [OWNER] },
    shutdown: { timeoutMs: 5_000 },
  };
});

afterEach(async () => {
  await kernel?.stop('test over');
  rmSync(root, { recursive: true, force: true });
});

let nextUpdate = 1;
function message(text: string) {
  const update = nextUpdate++;
  return {
    update_id: update,
    message: {
      message_id: update,
      date: 0,
      chat: { id: OWNER, type: 'private', first_name: 'owner' },
      from: { id: OWNER, is_bot: false, first_name: 'owner' },
      text,
    },
  } as never;
}

/**
 * Telegram, played by the test. `getMe` answers with `reachable()` so a test can
 * make the network be down and come back.
 */
function telegram(
  reachable: () => TelegramResponse | null = () => null,
  files: Readonly<Record<string, Uint8Array>> = {},
) {
  const sent: string[] = [];
  /** Every other method called, so a test can see a photo go out. */
  const methods: string[] = [];
  let bot: TelegramChannel | null = null;
  const open = (options: TelegramOptions): TelegramChannel => {
    bot = createTelegramChannel({
      ...options,
      startTimeoutMs: 50,
      albumWindowMs: 20,
      // Telegram's file server: a file's bytes, by the path getFile gave.
      download: async (filePath) => {
        const data = files[filePath];
        if (data === undefined) throw new Error(`no file at ${filePath}`);
        return data;
      },
      transport: (method, payload) => {
        if (method === 'getMe') return reachable() ?? { ok: true, result: BOT };
        if (method === 'getFile') {
          const id = String(payload['file_id']);
          return { ok: true, result: { file_id: id, file_unique_id: id, file_path: id } };
        }
        if (method === 'sendMessage') {
          sent.push(String(payload['text']));
          return {
            ok: true,
            result: { message_id: sent.length, date: 0, chat: { id: OWNER, type: 'private' } },
          };
        }
        methods.push(method);
        if (method === 'sendPhoto' || method === 'sendVideo' || method === 'sendDocument') {
          return {
            ok: true,
            result: { message_id: 0, date: 0, chat: { id: OWNER, type: 'private' } },
          };
        }
        return { ok: true, result: true };
      },
    });
    return bot;
  };
  return {
    open,
    sent,
    methods,
    get bot(): TelegramChannel {
      if (bot === null) throw new Error('the bot was never opened');
      return bot;
    },
  };
}

const token = () => new Secret('123456:SECRET-token_value');

/**
 * Why a component failed to start. The lifecycle wraps the failure — that is
 * its contract — and what matters to an operator, and to the exit code, is the
 * cause.
 */
function causeOf(error: unknown): AppError {
  expect(isAppError(error) && error.code).toBe('component-start-failed');
  const cause = (error as AppError).cause;
  if (!isAppError(cause)) throw new Error(`expected an AppError cause, got ${String(cause)}`);
  return cause;
}

async function start(over: Partial<KernelOptions> = {}, values = [answer('hello')]) {
  const runner = fakeRunner({ values });
  const tg = telegram();
  kernel = await startKernel({
    config,
    logger: recordingLogger(),
    version: '0.4.0',
    openRunner: async () => runner,
    readCredential: (name) => {
      expect(name).toBe(TELEGRAM_TOKEN);
      return token();
    },
    openTelegram: tg.open,
    ...over,
  });
  return { runner, tg, kernel };
}

describe('the bot, in the daemon', () => {
  it('takes a message from the owner’s phone to the agent and back', async () => {
    const { tg } = await start({}, [answer('seven is prime')]);

    await tg.bot.receive(message('is seven prime?'));

    await vi.waitFor(() => expect(tg.sent).toEqual(['seven is prime']));
  });

  it('talks to the same agent as the socket, so the conversation is one conversation', async () => {
    const { runner, tg } = await start({}, [answer('from the terminal'), answer('from the phone')]);

    const client = await connect({ path: socketPathFor(config.dataDir), onAsk: async () => false });
    try {
      expect(await client.say('one')).toBe('from the terminal');
    } finally {
      client.close();
    }
    await tg.bot.receive(message('two'));

    await vi.waitFor(() => expect(tg.sent).toEqual(['from the phone']));
    expect(runner.sessions).toBe(1);
    expect(runner.turns.map((turn) => turn.prompt)).toEqual(['one', 'two']);
  });

  it('reports itself healthy once polling, with how many strangers it turned away', async () => {
    const { kernel: running } = await start();

    const report = await running.health();
    const bot = report.components.find((component) => component.name === 'telegram');

    expect(bot?.health.status).toBe('ok');
    expect(bot?.health.detail).toContain('0 update(s) from outside the allowlist');
  });

  it('stops with the daemon', async () => {
    const { tg, kernel: running } = await start();

    await running.stop('test');
    kernel = null;

    expect(tg.bot.running).toBe(false);
  });
});

function photoMessage(fileId: string) {
  const update = nextUpdate++;
  return {
    update_id: update,
    message: {
      message_id: update,
      date: 0,
      chat: { id: OWNER, type: 'private', first_name: 'owner' },
      from: { id: OWNER, is_bot: false, first_name: 'owner' },
      photo: [{ file_id: fileId, file_unique_id: fileId, width: 1280, height: 960 }],
      caption: 'Write a post about this job',
    },
  } as never;
}

/** A JPEG as far as anything that reads its first bytes is concerned. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);

describe('a photo from the phone', () => {
  it('is kept on the machine and shown to the agent, which is told what it is called', async () => {
    const runner = fakeRunner({ values: [answer('A good post.')] });
    const tg = telegram(() => null, { 'photo-1': JPEG });
    kernel = await startKernel({
      config,
      logger: recordingLogger(),
      version: '0.4.0',
      openRunner: async () => runner,
      readCredential: () => token(),
      openTelegram: tg.open,
    });

    await tg.bot.receive(photoMessage('photo-1'));

    await vi.waitFor(() => expect(tg.sent).toEqual(['A good post.']));
    const [turn] = runner.turns;
    expect(turn?.images).toHaveLength(1);
    expect([...(turn?.images[0]?.data ?? [])]).toEqual([...JPEG]);
    expect(turn?.prompt).toContain('Write a post about this job');
    const held = readdirSync(join(config.dataDir, 'media'));
    expect(held).toHaveLength(1);
    expect(turn?.prompt).toContain(held[0]?.split('.')[0]);
  });

  it('can be sent back by the id it is held under, and an invented id sends nothing', async () => {
    const id = createHash('sha256').update(JPEG).digest('hex').slice(0, 16);
    const runner = fakeRunner({
      values: [
        answer('Got it.'),
        { reply: 'This one for the cover.', actions: [], attachments: [id] },
        { reply: 'And this one.', actions: [], attachments: ['ffffffffffffffff'] },
      ],
    });
    const tg = telegram(() => null, { 'photo-1': JPEG });
    kernel = await startKernel({
      config,
      logger: recordingLogger(),
      version: '0.4.0',
      openRunner: async () => runner,
      readCredential: () => token(),
      openTelegram: tg.open,
    });

    await tg.bot.receive(photoMessage('photo-1'));
    await vi.waitFor(() => expect(tg.sent).toEqual(['Got it.']));
    await tg.bot.receive(message('which should be the cover?'));
    await vi.waitFor(() => expect(tg.methods).toContain('sendPhoto'));
    expect(tg.sent[1]).toBe('This one for the cover.');

    await tg.bot.receive(message('and another?'));
    await vi.waitFor(() => expect(tg.sent).toHaveLength(3));
    expect(tg.sent[2]).toContain('the system holds no file called ffffffffffffffff');
    expect(tg.methods.filter((method) => method === 'sendPhoto')).toHaveLength(1);
  });

  it('is turned away in words when it is not an image at all, and costs no turn', async () => {
    const runner = fakeRunner({ values: [] });
    const tg = telegram(() => null, { 'not-a-photo': new TextEncoder().encode('<html>') });
    kernel = await startKernel({
      config,
      logger: recordingLogger(),
      version: '0.4.0',
      openRunner: async () => runner,
      readCredential: () => token(),
      openTelegram: tg.open,
    });

    await tg.bot.receive(photoMessage('not-a-photo'));

    await vi.waitFor(() => expect(tg.sent).toHaveLength(1));
    expect(tg.sent[0]).toContain('not an image');
    expect(runner.turns).toHaveLength(0);
  });
});

describe('the image types', () => {
  it('the store accepts are exactly the ones the port can carry', () => {
    // `@cortana/runner` names the four types the provider takes and
    // `@cortana/media` decides which bytes are which, and neither depends on
    // the other. This is where they are held together.
    expect([...IMAGE_TYPES]).toEqual([...TURN_IMAGE_TYPES]);
  });
});

describe('when the bot is not configured', () => {
  it('opens nothing and asks for no credential', async () => {
    const readCredential = vi.fn(() => token());
    const tg = telegram();
    const { telegram: _, ...withoutBot } = config;
    config = withoutBot;

    const { kernel: running } = await start({ readCredential, openTelegram: tg.open });

    expect(readCredential).not.toHaveBeenCalled();
    const report = await running.health();
    expect(report.components.map((component) => component.name)).not.toContain('telegram');
  });
});

describe('a failure at start', () => {
  it('stops the daemon when the token cannot be read, and says which credential', async () => {
    const error = await start({
      readCredential: () => {
        throw new AppError('the credential "telegram-bot-token" cannot be read: it is missing', {
          category: 'config',
          code: 'credential-missing',
        });
      },
    }).catch((caught: unknown) => caught);
    kernel = null;

    expect(causeOf(error).category).toBe('config');
    expect(causeOf(error).message).toContain('telegram-bot-token');
  });

  it('stops the daemon when Telegram refuses the token', async () => {
    const tg = telegram(() => ({ ok: false, error_code: 401, description: 'Unauthorized' }));

    const error = await start({ openTelegram: tg.open }).catch((caught: unknown) => caught);
    kernel = null;

    expect(causeOf(error).code).toBe('telegram-token-refused');
    expect(causeOf(error).category).toBe('config');
  });

  it('stops the daemon when no credential reader was given', async () => {
    const { readCredential: _, ...rest } = {
      config,
      logger: recordingLogger(),
      version: '0.4.0',
      readCredential: undefined,
    };
    const error = await startKernel(rest).catch((caught: unknown) => caught);

    expect(causeOf(error).code).toBe('no-credential-reader');
  });

  it('does not stop the daemon when Telegram cannot be reached, and tries again', async () => {
    // The commonest failure there is: the network is down at boot. The socket
    // still answers, the component says it is failing, and when Telegram comes
    // back the bot does too.
    let down = true;
    const tg = telegram(() =>
      down ? { ok: false, error_code: 502, description: 'Bad Gateway' } : null,
    );
    const { kernel: running } = await start({ openTelegram: tg.open, telegramRetryMs: 20 }, [
      answer('the socket still works'),
    ]);

    const unhealthy = (await running.health()).components.find((c) => c.name === 'telegram');
    expect(unhealthy?.health.status).toBe('failing');
    // Why, not only that: "not polling" is true and sends the operator to read
    // logs for the reason this already knows.
    expect(unhealthy?.health.detail).toContain('could not be reached');

    const client = await connect({ path: socketPathFor(config.dataDir), onAsk: async () => false });
    try {
      expect(await client.say('hello?')).toBe('the socket still works');
    } finally {
      client.close();
    }

    down = false;
    await vi.waitFor(async () => {
      const bot = (await running.health()).components.find((c) => c.name === 'telegram');
      expect(bot?.health.status).toBe('ok');
    });
  });

  it('stops trying when the daemon stops', async () => {
    let attempts = 0;
    const tg = telegram(() => {
      attempts += 1;
      return { ok: false, error_code: 502, description: 'Bad Gateway' };
    });
    const { kernel: running } = await start({ openTelegram: tg.open, telegramRetryMs: 10 });

    await running.stop('test');
    kernel = null;
    const after = attempts;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(attempts).toBe(after);
  });
});
