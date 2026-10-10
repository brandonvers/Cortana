/**
 * The bot you talk to it through from a phone.
 *
 * It is the socket's twin. A message becomes a turn through the same `onSay` the
 * socket calls, an approval becomes a question through the same `Conversation`,
 * and the agent never learns which of the two a sentence arrived on. What is
 * different is who can reach it: a socket in a `0700` directory has no
 * authentication to get wrong, and a bot on Telegram can be messaged by anybody
 * who finds its name.
 *
 * ## So the allowlist is the first thing every update meets
 *
 * Numeric user ids, which Telegram asserts, rather than usernames, which their
 * owners change. Private chats only: in a group the owner's message sits among
 * other people's. An update from anyone else is dropped **before anything but its
 * sender is read** — never answered, because an answer tells a stranger the bot
 * is alive, and never turned into a turn, so a stranger's text reaches neither
 * the model nor the audit. It is counted, so the dropping is visible.
 *
 * ## Why a turn does not run inside the update handler
 *
 * grammY's long polling handles updates one at a time and fetches the next only
 * when the handler returns. An approval arrives as its own update — a button
 * press — **while the turn that asked is still waiting for it**. A handler that
 * awaited the turn would hold the button press behind the turn, and every
 * approval would time out into a refusal: a deadlock that looks like an owner
 * who never answers. So a message is queued and the handler returns; turns run
 * one after another on that queue, and button presses are handled as they come.
 *
 * The cost is stated rather than hidden: an update is confirmed to Telegram when
 * its handler returns, which is before its turn has run. A daemon killed in the
 * middle of a turn does not get that message again; the owner sees no reply and
 * asks again. The socket loses an interrupted message the same way.
 *
 * ## A forwarded message is not the owner's words
 *
 * It carries somebody else's text, and ADR-0007 says what happens to that: it is
 * inspected before it is trusted. Until the quarantine is reachable from a
 * channel, a forwarded message is **refused with a sentence saying why** rather
 * than handed to the main agent as though the owner had typed it.
 */

import { randomBytes } from 'node:crypto';
import type { Conversation, SayHandler } from '@cortana/channel';
import type { Secret } from '@cortana/config';
import { AppError, isAppError, type Logger } from '@cortana/core';
import { Bot, GrammyError, InlineKeyboard } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { splitForTelegram } from './split.ts';

/** How long an unanswered question waits before it is a no. The socket's figure. */
const DEFAULT_ASK_TIMEOUT_MS = 120_000;

/**
 * How long `start` waits for Telegram to say who the bot is.
 *
 * grammY's own `init` retries a server error or a dropped connection **forever**,
 * backing off from 100 ms to several seconds — measured, not read — so an
 * unreachable Telegram at boot was a start that never returned, and a daemon
 * that never finished coming up. Bounded here, a start either proves the token
 * or says Telegram could not be reached, and whoever started it decides what
 * to do about that.
 */
const DEFAULT_START_TIMEOUT_MS = 10_000;

/** Telegram shows "typing…" for five seconds per call, so it is renewed inside that. */
const TYPING_EVERY_MS = 4_000;

export const FORWARDED_REFUSAL =
  'A forwarded message is somebody else’s words, and it would reach the agent as ' +
  'though you had written them. That is not allowed yet — copy the part you mean ' +
  'into a message of your own.';

export const TEXT_ONLY =
  'Only text reaches the agent for now. Photos, voice and files are not passed on.';

export const TURN_FAILED = 'Something went wrong answering that. The details are in the log.';

const ALLOWED = 'Allowed.';
const REFUSED = 'Refused.';
const UNANSWERED = 'No answer, so refused.';
const CLOSED = 'The daemon stopped before this was answered, so it was refused.';
const STALE = 'That question is no longer open.';

/** What Telegram's API answers, in its own envelope. */
export type TelegramResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error_code: number; readonly description: string };

/**
 * Answers every call to Telegram's API instead of the network.
 *
 * Tests only. It answers in the API's own envelope rather than with bare
 * results, so a refusal can be what Telegram actually sends — a 401 for a bad
 * token is the case worth being able to write.
 */
export type TelegramTransport = (
  method: string,
  payload: Record<string, unknown>,
) => TelegramResponse | Promise<TelegramResponse>;

export interface TelegramOptions {
  readonly token: Secret;
  /** Who may talk to it. Numeric Telegram user ids; nobody else reaches anything. */
  readonly allowedUserIds: readonly number[];
  readonly onSay: SayHandler;
  readonly logger?: Logger;
  readonly askTimeoutMs?: number;
  /** How long to wait for Telegram at start before calling it unreachable. */
  readonly startTimeoutMs?: number;
  readonly transport?: TelegramTransport;
  readonly botInfo?: UserFromGetMe;
}

export interface TelegramChannel {
  /** Learns who the bot is, which proves the token, then starts polling. */
  start(): Promise<void>;
  /** Stops polling and refuses every open question. A turn in progress may still reply. */
  stop(): Promise<void>;
  /** One update, as polling hands it over. Public so a test can be the network. */
  receive(update: Update): Promise<void>;
  readonly running: boolean;
  /** Updates dropped because they came from outside the allowlist. */
  readonly refused: number;
}

interface OpenQuestion {
  /** Where it was asked, so an answer from anywhere else is not one. */
  readonly chatId: number;
  settle(approved: boolean, outcome: string): void;
}

export function createTelegramChannel(options: TelegramOptions): TelegramChannel {
  if (options.allowedUserIds.length === 0) {
    // Not a configuration a person means. An empty allowlist is a bot that
    // drops everything, and it is far likelier to be a missing line than a
    // decision.
    throw new AppError('the Telegram channel has nobody allowed to talk to it', {
      category: 'config',
      code: 'telegram-empty-allowlist',
    });
  }

  const log = options.logger?.child({ component: 'telegram' });
  const allowed = new Set(options.allowedUserIds);
  const askTimeoutMs = options.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;

  const bot = new Bot(options.token.expose(), {
    ...(options.botInfo === undefined ? {} : { botInfo: options.botInfo }),
  });
  if (options.transport !== undefined) {
    const transport = options.transport;
    bot.api.config.use(
      async (_prev, method, payload) =>
        (await transport(method, payload as Record<string, unknown>)) as never,
    );
  }

  let refused = 0;
  let started = false;
  const open = new Map<string, OpenQuestion>();
  /** The turn queue. One at a time, in the order they were sent. */
  let tail: Promise<void> = Promise.resolve();

  const sendText = async (chatId: number, text: string): Promise<void> => {
    for (const piece of splitForTelegram(text)) {
      await bot.api.sendMessage(chatId, piece);
    }
  };

  /** A message the owner will read, which must not take the daemon down with it. */
  const tell = async (chatId: number, text: string): Promise<void> => {
    try {
      await sendText(chatId, text);
    } catch (error) {
      log?.error('a message to the owner could not be sent', { error: describe(error) });
    }
  };

  const conversationIn = (chatId: number): Conversation => ({
    async ask(question, because) {
      const id = randomBytes(6).toString('hex');
      let sent: number | null = null;
      try {
        const message = await bot.api.sendMessage(chatId, `${question}\n\n${because}`, {
          reply_markup: new InlineKeyboard()
            .text('Allow', `ask:${id}:y`)
            .text('Refuse', `ask:${id}:n`),
        });
        sent = message.message_id;
      } catch (error) {
        // Nobody can answer a question that never arrived, and the safe
        // answer to an unasked question about doing something is no.
        log?.error('an approval could not be sent, so it is refused', { error: describe(error) });
        return false;
      }

      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          log?.warn('an approval went unanswered and was treated as a refusal', { askTimeoutMs });
          entry.settle(false, UNANSWERED);
        }, askTimeoutMs);

        const entry: OpenQuestion = {
          chatId,
          settle(approved, outcome) {
            if (!open.delete(id)) return;
            clearTimeout(timer);
            resolve(approved);
            // Said on the question itself, and its buttons removed, so the
            // phone shows what was decided rather than buttons that still look
            // pressable.
            if (sent !== null) {
              bot.api
                .editMessageText(chatId, sent, `${question}\n\n${outcome}`)
                .catch((error: unknown) =>
                  log?.debug('an answered question could not be updated', {
                    error: describe(error),
                  }),
                );
            }
          },
        };
        open.set(id, entry);
      });
    },
  });

  const runTurn = async (chatId: number, text: string): Promise<void> => {
    const typing = () => {
      bot.api.sendChatAction(chatId, 'typing').catch(() => {
        // Cosmetic. A failed indicator is not worth a log line per renewal.
      });
    };
    typing();
    const renew = setInterval(typing, TYPING_EVERY_MS);
    try {
      const reply = await options.onSay(text, conversationIn(chatId));
      await tell(chatId, reply);
    } catch (error) {
      log?.error('a turn failed', { error: describe(error) });
      // A missing provider is the one failure the owner can act on, so it
      // reaches them as its own sentence — the socket's rule. Anything else is
      // a sentence that points at the log, never a stack trace on a phone.
      await tell(
        chatId,
        isAppError(error) && error.category === 'config' ? error.message : TURN_FAILED,
      );
    } finally {
      clearInterval(renew);
    }
  };

  // Every update meets the allowlist before any handler sees it.
  bot.use(async (ctx, next) => {
    const from = ctx.from?.id;
    const isPrivate = ctx.chat === undefined || ctx.chat.type === 'private';
    if (from === undefined || !allowed.has(from) || !isPrivate) {
      refused += 1;
      log?.info('an update from outside the allowlist was dropped', {
        from: from ?? null,
        chat: ctx.chat?.type ?? null,
      });
      return;
    }
    await next();
  });

  bot.on('callback_query:data', async (ctx) => {
    const match = /^ask:([0-9a-f]+):([yn])$/.exec(ctx.callbackQuery.data);
    const question = match?.[1] === undefined ? undefined : open.get(match[1]);
    // The press has to come from the chat the question was asked in. The
    // allowlist already admits only the owner, so this is the second statement
    // of it rather than the control.
    if (question === undefined || question.chatId !== ctx.chat?.id) {
      await ctx.answerCallbackQuery({ text: STALE }).catch(() => {});
      return;
    }
    const approved = match?.[2] === 'y';
    question.settle(approved, approved ? ALLOWED : REFUSED);
    await ctx.answerCallbackQuery().catch(() => {});
  });

  bot.on('message', (ctx) => {
    const chatId = ctx.chat.id;
    const message = ctx.message;
    if (message.forward_origin !== undefined) {
      tail = tail.then(() => tell(chatId, FORWARDED_REFUSAL));
      return;
    }
    if (message.text === undefined) {
      tail = tail.then(() => tell(chatId, TEXT_ONLY));
      return;
    }
    const text = message.text;
    // Queued, not awaited — see the note at the top of this file.
    tail = tail.then(() => runTurn(chatId, text));
  });

  bot.catch((error) => {
    log?.error('an update could not be handled', { error: describe(error.error) });
  });

  return {
    async start() {
      const deadline = AbortSignal.timeout(options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
      try {
        // grammY types its signal as the `abort-controller` polyfill's. The
        // platform's own is what it gets at runtime, and the test that gives up
        // on an unreachable Telegram is what shows it is honoured.
        await bot.init(deadline as never);
      } catch (error) {
        // A 401 is not retried by grammY, so it arrives here at once and is
        // the one answer that means the token itself is wrong.
        if (error instanceof GrammyError && error.error_code === 401) {
          throw new AppError('Telegram did not accept the bot token', {
            category: 'config',
            code: 'telegram-token-refused',
          });
        }
        throw new AppError('Telegram could not be reached to start the bot', {
          category: 'unavailable',
          code: 'telegram-unreachable',
          detail: { error: deadline.aborted ? 'no answer before the deadline' : describe(error) },
        });
      }
      log?.info('the Telegram channel is listening', {
        bot: bot.botInfo.username,
        allowed: allowed.size,
      });
      started = true;
      // Nothing to poll when a test is the network: it hands updates to
      // `receive` itself.
      if (options.transport !== undefined) return;
      // Not awaited: it settles only when polling ends. grammY retries the
      // network on its own, so an end that was not `stop` is worth a line.
      bot
        .start({ allowed_updates: ['message', 'callback_query'] })
        .catch((error: unknown) => {
          log?.error('Telegram polling stopped', { error: describe(error) });
        })
        .finally(() => {
          started = false;
        });
    },

    async stop() {
      started = false;
      if (bot.isRunning()) await bot.stop();
      for (const question of [...open.values()]) question.settle(false, CLOSED);
    },

    receive: (update) => bot.handleUpdate(update),

    get running() {
      return started;
    },

    get refused() {
      return refused;
    },
  };
}

/**
 * An error as a sentence, without the request it came from.
 *
 * grammY's network errors describe the call, and the call's URL has the token
 * in it. The message is enough to act on and the URL is never needed.
 */
function describe(error: unknown): string {
  if (error instanceof GrammyError) return `${error.method}: ${error.description}`;
  if (error instanceof Error) return error.message.replace(/bot\d+:[\w-]+/g, 'bot[redacted]');
  return String(error).replace(/bot\d+:[\w-]+/g, 'bot[redacted]');
}
