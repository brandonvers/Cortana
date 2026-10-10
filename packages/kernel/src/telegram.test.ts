import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, socketPathFor } from '@cortana/channel';
import { type Config, Secret } from '@cortana/config';
import { AppError, isAppError } from '@cortana/core';
import { recordingLogger } from '@cortana/core/testing';
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
function telegram(reachable: () => TelegramResponse | null = () => null) {
  const sent: string[] = [];
  let bot: TelegramChannel | null = null;
  const open = (options: TelegramOptions): TelegramChannel => {
    bot = createTelegramChannel({
      ...options,
      startTimeoutMs: 50,
      transport: (method, payload) => {
        if (method === 'getMe') return reachable() ?? { ok: true, result: BOT };
        if (method === 'sendMessage') {
          sent.push(String(payload['text']));
          return {
            ok: true,
            result: { message_id: sent.length, date: 0, chat: { id: OWNER, type: 'private' } },
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
