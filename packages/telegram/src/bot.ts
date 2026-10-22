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
import {
  type Conversation,
  type IncomingImage,
  type OutgoingFile,
  PHRASES,
  type Phrasebook,
  type SayHandler,
  textOf,
} from '@cortana/channel';
import type { Secret } from '@cortana/config';
import { AppError, isAppError, type Logger } from '@cortana/core';
import { Bot, GrammyError, InlineKeyboard, InputFile } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { splitForTelegram, TELEGRAM_MAX_MESSAGE } from './split.ts';

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

export const FORWARDED_REFUSAL = PHRASES.en.forwardedRefusal;

export const NOT_PASSED_ON = PHRASES.en.notPassedOn;

export const PHOTO_NOT_FETCHED = PHRASES.en.mediaNotFetched;

/**
 * How long an album is waited on after its latest photo.
 *
 * Telegram delivers an album as one update per photo, sharing a
 * `media_group_id`, with nothing to say which is the last. A second is far more
 * than the gap between them and short enough that nobody notices it.
 */
const DEFAULT_ALBUM_WINDOW_MS = 1_000;

/** The most Telegram lets a bot download, in bytes. Its own limit, not a choice. */
const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export const TURN_FAILED = PHRASES.en.turnFailed;

/** A file name's ending for a type, so the phone opens it with the right app. */
function extensionOf(mediaType: string): string {
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
  };
  return known[mediaType] ?? 'bin';
}

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
  readonly albumWindowMs?: number;
  /** What the bot itself says, in the owner's language. English when not given. */
  readonly phrases?: Phrasebook;
  /**
   * Fetches a file Telegram holds, by the path `getFile` gave for it. Replaced
   * in tests, so a test can be Telegram's file server too.
   */
  readonly download?: (filePath: string) => Promise<Uint8Array>;
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
  const phrases = options.phrases ?? PHRASES.en;
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
    for (const piece of splitForTelegram(text, TELEGRAM_MAX_MESSAGE, phrases.emptyReply)) {
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

  /**
   * The files of a reply, after its text, one message each.
   *
   * By type: an image as a photo, a video as a video, anything else as a
   * document. A photo is recompressed by Telegram, which is fine for seeing
   * which picture was meant — the person holds the original. A file that fails
   * to send is said, and does not stop the ones after it.
   */
  const sendFiles = async (chatId: number, files: readonly OutgoingFile[]): Promise<void> => {
    for (const file of files) {
      const upload = new InputFile(file.data, `${file.id}.${extensionOf(file.mediaType)}`);
      try {
        if (file.mediaType.startsWith('image/')) await bot.api.sendPhoto(chatId, upload);
        else if (file.mediaType.startsWith('video/')) await bot.api.sendVideo(chatId, upload);
        else await bot.api.sendDocument(chatId, upload);
      } catch (error) {
        log?.error('a file could not be sent', { id: file.id, error: describe(error) });
        await tell(chatId, phrases.fileNotSent(file.id));
      }
    }
  };

  const conversationIn = (chatId: number): Conversation => ({
    async ask(question, because) {
      const id = randomBytes(6).toString('hex');
      let sent: number | null = null;
      try {
        const message = await bot.api.sendMessage(chatId, `${question}\n\n${because}`, {
          reply_markup: new InlineKeyboard()
            .text(phrases.allow, `ask:${id}:y`)
            .text(phrases.refuse, `ask:${id}:n`),
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
          entry.settle(false, phrases.unanswered);
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

  const runTurn = async (
    chatId: number,
    text: string,
    images?: readonly IncomingImage[],
  ): Promise<void> => {
    const typing = () => {
      bot.api.sendChatAction(chatId, 'typing').catch(() => {
        // Cosmetic. A failed indicator is not worth a log line per renewal.
      });
    };
    typing();
    const renew = setInterval(typing, TYPING_EVERY_MS);
    try {
      // A text message is said exactly as it was before photos existed.
      const conversation = conversationIn(chatId);
      const reply =
        images === undefined
          ? await options.onSay(text, conversation)
          : await options.onSay(text, conversation, images);
      await tell(chatId, textOf(reply));
      if (typeof reply !== 'string') await sendFiles(chatId, reply.files);
    } catch (error) {
      log?.error('a turn failed', { error: describe(error) });
      // A missing provider is the one failure the owner can act on, so it
      // reaches them as its own sentence — the socket's rule. Anything else is
      // a sentence that points at the log, never a stack trace on a phone.
      await tell(
        chatId,
        isAppError(error) && error.category === 'config' ? error.message : phrases.turnFailed,
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
      await ctx.answerCallbackQuery({ text: phrases.stale }).catch(() => {});
      return;
    }
    const approved = match?.[2] === 'y';
    question.settle(approved, approved ? phrases.allowed : phrases.refused);
    await ctx.answerCallbackQuery().catch(() => {});
  });

  const download =
    options.download ??
    (async (filePath: string): Promise<Uint8Array> => {
      // The token is in this URL, so it appears in no error: a failure says
      // what happened, never where.
      const response = await fetch(
        `https://api.telegram.org/file/bot${options.token.expose()}/${filePath}`,
        { signal: AbortSignal.timeout(60_000) },
      ).catch(() => {
        throw new Error('the file could not be fetched from Telegram');
      });
      if (!response.ok) throw new Error(`Telegram answered ${response.status} for a file`);
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.length > TELEGRAM_DOWNLOAD_LIMIT) throw new Error('the file is over 20 MB');
      return data;
    });

  /**
   * A photo's bytes, as a value that never rejects.
   *
   * It starts as soon as the update arrives and is awaited only when its turn
   * comes, and a promise that rejected in between with nothing attached would
   * reach the daemon's unhandled-rejection handler — which ends the process.
   */
  const fetchImage = (fileId: string): Promise<IncomingImage | null> =>
    bot.api
      .getFile(fileId)
      .then((file) => {
        if (file.file_path === undefined) throw new Error('Telegram gave no path for the file');
        return download(file.file_path);
      })
      .then(
        (data) => ({ data }),
        (error: unknown) => {
          log?.error('a photo could not be fetched', { error: describe(error) });
          return null;
        },
      );

  const runPhotoTurn = async (
    chatId: number,
    text: string,
    fetched: readonly Promise<IncomingImage | null>[],
  ): Promise<void> => {
    const images = await Promise.all(fetched);
    if (images.some((image) => image === null)) {
      await tell(chatId, phrases.mediaNotFetched);
      return;
    }
    await runTurn(chatId, text, images as IncomingImage[]);
  };

  interface Album {
    readonly fetched: Promise<IncomingImage | null>[];
    caption: string;
    timer: NodeJS.Timeout | null;
    close(): void;
  }
  const albums = new Map<string, Album>();
  const albumWindowMs = options.albumWindowMs ?? DEFAULT_ALBUM_WINDOW_MS;

  /**
   * One photo of an album, joined to the others by their group id.
   *
   * The album's place in the queue is taken when its first photo arrives, not
   * when the window closes, so a message sent after an album is answered after
   * it. The turn itself waits for the window to close, then takes every photo
   * the album gathered.
   */
  const joinAlbum = (
    groupId: string,
    chatId: number,
    fetched: Promise<IncomingImage | null>,
    caption: string,
  ): void => {
    let album = albums.get(groupId);
    if (album === undefined) {
      let close: () => void = () => {};
      const closed = new Promise<void>((resolve) => {
        close = resolve;
      });
      const created: Album = { fetched: [], caption: '', timer: null, close };
      album = created;
      albums.set(groupId, created);
      tail = tail.then(async () => {
        await closed;
        await runPhotoTurn(chatId, created.caption, created.fetched);
      });
    }
    album.fetched.push(fetched);
    if (caption !== '') album.caption = caption;
    if (album.timer !== null) clearTimeout(album.timer);
    const current = album;
    album.timer = setTimeout(() => {
      albums.delete(groupId);
      current.close();
    }, albumWindowMs);
  };

  bot.on('message', (ctx) => {
    const chatId = ctx.chat.id;
    const message = ctx.message;
    if (message.forward_origin !== undefined) {
      tail = tail.then(() => tell(chatId, phrases.forwardedRefusal));
      return;
    }

    // The largest size Telegram made of a photo is the last one, and a picture
    // sent "as a file" keeps its original — either is a photo to the agent.
    const fileId =
      message.photo?.at(-1)?.file_id ??
      (message.document?.mime_type?.startsWith('image/') ? message.document.file_id : undefined);
    if (fileId !== undefined) {
      const fetched = fetchImage(fileId);
      const caption = message.caption ?? '';
      if (message.media_group_id !== undefined) {
        joinAlbum(message.media_group_id, chatId, fetched, caption);
        return;
      }
      tail = tail.then(() => runPhotoTurn(chatId, caption, [fetched]));
      return;
    }

    if (message.text === undefined) {
      tail = tail.then(() => tell(chatId, phrases.notPassedOn));
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
      // An album still gathering is let go: its turn runs with what arrived, if
      // the daemon is still there to run it, and its timer keeps nothing alive.
      for (const album of albums.values()) {
        if (album.timer !== null) clearTimeout(album.timer);
        album.close();
      }
      albums.clear();
      if (bot.isRunning()) await bot.stop();
      for (const question of [...open.values()]) question.settle(false, phrases.closed);
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
