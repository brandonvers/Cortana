/**
 * The two components that make the daemon something you can talk to.
 *
 * M3's plan listed five steps and needed a sixth: the parts existed and nothing
 * held them at once. This is that, and almost all of it is decisions about
 * *when* rather than *what*.
 *
 * ## The agent is opened on the first thing you say
 *
 * Not when the daemon starts. [Spike 0003](../../../docs/spikes/0003-concurrent-sessions.md)
 * priced an idle session at **263 MB** and a cold start at 5.4–6.2 s, and
 * CONCEPTS §3.3 already draws the conclusion: "residency is an identity, not a
 * running process… an agent that is always awake is always costing tokens and
 * context." A daemon nobody has spoken to should be holding a socket and a
 * database, not a model session.
 *
 * The cost of that choice is that the first message is slow, and that a
 * misconfigured provider is discovered on first use rather than at boot. The
 * second is worth more than it costs: [ADR-0020](../../../docs/adr/0020-the-provider-sdk-is-a-peer-dependency.md)
 * makes the SDK an optional peer, so a daemon that refused to start without it
 * would be refusing to do the things it can still do — recording, migrating,
 * reporting health — because of one it was told might be absent.
 *
 * ## Which is why a missing provider is an answer rather than a silence
 *
 * With no SDK installed there is no agent, and the operator is on a socket
 * typing into something. They get the sentence naming the package, on the
 * channel they are already using. A daemon that simply never opened the socket
 * would leave them reading logs to find out why.
 *
 * ## Why the runner arrives as a function
 *
 * `openRunner` rather than an import. [ADR-0001](../../../docs/adr/0001-model-access-behind-a-port.md)
 * puts every provider name in one adapter package, and a kernel that imported
 * one would make "which provider" a property of the kernel. The daemon picks;
 * this file only knows there is a port.
 */

import { join } from 'node:path';
import { type Agent, createAgent, type SentImage } from '@cortana/agent';
import { auditedRunner } from '@cortana/audit';
import {
  approvalThrough,
  type Channel,
  type Conversation,
  createChannel,
  type IncomingImage,
} from '@cortana/channel';
import type { Config } from '@cortana/config';
import { AppError, type InstanceId, isAppError, type Logger } from '@cortana/core';
import { createMediaStore, type MediaStore } from '@cortana/media';
import { workingProfile } from '@cortana/policy';
import type { ModelRunner } from '@cortana/runner';
import type { Storage, Writer } from '@cortana/storage';
import {
  createTelegramChannel,
  type TelegramChannel,
  type TelegramOptions,
} from '@cortana/telegram';
import { eq } from 'drizzle-orm';
import type { ReadCredential } from './credentials.ts';
import type { Component } from './lifecycle.ts';
import { agentSessions } from './schema.ts';

/** The agent this file runs. The roster's agents get their own names in M4. */
const MAIN = 'main';

/** What a person sends to set the conversation aside and begin another. */
export const NEW_CONVERSATION = '/new';
export const STARTED_OVER =
  'Started a new conversation. What was said before is no longer carried forward.';

/** The name the bot's token is stored under, on every rung. */
export const TELEGRAM_TOKEN = 'telegram-bot-token';

/** How long to wait before trying Telegram again after it could not be reached. */
const TELEGRAM_RETRY_MS = 30_000;

/** Opens the model runner this daemon will use. Supplied by whoever picks one. */
export type OpenRunner = () => Promise<ModelRunner>;

export interface ConversationOptions {
  readonly config: Config;
  readonly logger: Logger;
  readonly writer: Writer;
  /** Read from, for the one thing remembered between processes: the conversation's token. */
  readonly storage: Storage;
  readonly instanceId: InstanceId;
  /** Absent when nothing has chosen a provider, which is a supported state. */
  readonly openRunner?: OpenRunner;
  /**
   * Reads a credential from wherever this machine keeps them. Needed only when
   * something configured needs one — today, the Telegram bot.
   */
  readonly readCredential?: ReadCredential;
  /** Builds the bot. Replaced in tests, so that a test can be Telegram. */
  readonly openTelegram?: (options: TelegramOptions) => TelegramChannel;
  readonly telegramRetryMs?: number;
}

export interface ConversationParts {
  /** In start order, so the lifecycle stops them in the reverse of it. */
  readonly components: readonly Component[];
  /** The agent, once something has said anything. For tests and for health. */
  current(): Agent | null;
}

/**
 * Builds the agent and the socket, in the order they have to come up and go
 * down.
 *
 * The agent component starts first and therefore **stops last**, which is the
 * ordering that matters: the channel stops first, so no new message arrives
 * while the session it would need is closing.
 */
export function conversationComponents(options: ConversationOptions): ConversationParts {
  const log = options.logger;

  /**
   * What the one agent may do.
   *
   * Generated from the configuration rather than written out, so that the
   * sandbox requirement is derived from the tools rather than configured beside
   * them — see `workingProfile`. With the default configuration this profile
   * permits nothing at all, and the agent can only talk.
   */
  const profile = workingProfile({
    name: 'main',
    tools: options.config.agent.tools,
    readable: options.config.agent.readable,
    writable: options.config.agent.writable,
    confirm: options.config.agent.confirm,
  });

  let agent: Agent | null = null;
  let channel: Channel | null = null;
  /** So a broken provider is reported once rather than on every message. */
  let announced = false;

  /**
   * The agent, opening it if this is the first thing anybody has said.
   *
   * Serialised by the channel's own handler being awaited per message, and by
   * the agent's turn queue after that. Two messages arriving in the same tick
   * would both find `agent` null, so the promise is stored rather than the
   * result — otherwise the first conversation would open two sessions at
   * 263 MB each and keep the second.
   */
  let opening: Promise<Agent> | null = null;
  /**
   * Whether the agent was opened to continue a saved conversation and has not
   * yet answered. Only then is a lost conversation a reason to start afresh:
   * once a turn has worked, the conversation demonstrably exists.
   */
  let continuing = false;
  let runnerName: string | null = null;

  const savedConversation = (): { runner: string; resume: string } | null =>
    options.storage.db
      .select({ runner: agentSessions.runner, resume: agentSessions.resume })
      .from(agentSessions)
      .where(eq(agentSessions.agent, MAIN))
      .get() ?? null;

  const saveConversation = async (resume: string, runner: string): Promise<void> => {
    await options.writer.write('remember where the conversation is', ({ db }) => {
      const row = { agent: MAIN, runner, resume, updatedAt: Date.now() };
      db.insert(agentSessions)
        .values(row)
        .onConflictDoUpdate({ target: agentSessions.agent, set: row })
        .run();
    });
  };

  const forgetConversation = async (): Promise<void> => {
    await options.writer.write('forget where the conversation is', ({ db }) => {
      db.delete(agentSessions).where(eq(agentSessions.agent, MAIN)).run();
    });
  };

  /** Ends the agent's session, so the next message opens a new one. */
  const startOver = async (): Promise<void> => {
    await forgetConversation();
    const stopping = agent;
    agent = null;
    continuing = false;
    await stopping?.stop();
  };

  const ensureAgent = async (): Promise<Agent> => {
    if (agent !== null && !agent.stopped) return agent;
    if (opening !== null) return opening;

    const open = options.openRunner;
    if (open === undefined) {
      throw new AppError('no model provider is configured, so there is nothing here to talk to', {
        category: 'config',
        code: 'no-runner-configured',
      });
    }

    opening = (async () => {
      const runner = auditedRunner(await open(), {
        writer: options.writer,
        instanceId: options.instanceId,
        logger: log,
      });
      // Carried on from the last process, when the same runner left a token.
      // A token from another runner names nothing it could continue.
      const saved = savedConversation();
      const resume = saved !== null && saved.runner === runner.name ? saved.resume : undefined;
      const started = await createAgent({
        runner,
        profile,
        persona: options.config.agent.persona,
        tier: options.config.agent.tier,
        logger: log,
        ...(resume === undefined ? {} : { resume }),
      });
      agent = started;
      continuing = resume !== undefined;
      runnerName = runner.name;
      log.info('the agent is awake', {
        session: started.id,
        profile: profile.name,
        conversation: continuing ? 'continued' : 'new',
      });
      return started;
    })();

    try {
      return await opening;
    } finally {
      // Cleared either way. Holding a rejected promise here would make one
      // failed start permanent: every later message would await the same
      // rejection and the daemon would never try again.
      opening = null;
    }
  };

  const agentComponent: Component = {
    name: 'agent',
    start() {
      // Nothing. Spike 0003's 263 MB is why: an agent nobody has spoken to is
      // an identity rather than a session, and this component exists to stop
      // one, not to start it.
      log.debug('the agent will open on the first message', { profile: profile.name });
    },
    async stop() {
      await agent?.stop();
    },
    health() {
      if (agent === null) return { status: 'ok' as const, detail: 'dormant' };
      return agent.stopped
        ? { status: 'degraded' as const, detail: 'the session has stopped' }
        : { status: 'ok' as const, detail: `session ${agent.id}` };
    },
  };

  /**
   * One turn, from whichever channel it arrived on.
   *
   * Both channels call this, so a sentence reaches the agent the same way from a
   * terminal and from a phone, and the agent — one session, one memory of the
   * conversation — never learns which it was.
   */
  /**
   * Where what the person sends is kept. Opened on the first image rather than
   * at construction: this runs before the storage component has made the data
   * directory, and a store that made it first would make it with its own mode.
   */
  let media: MediaStore | null = null;
  const store = (): MediaStore => {
    media ??= createMediaStore({ dir: join(options.config.dataDir, 'media') });
    return media;
  };

  const answer = async (
    text: string,
    conversation: Conversation,
    images?: readonly IncomingImage[],
  ): Promise<string> => {
    // Kept before the turn, so the agent is handed ids the store already holds.
    // A file the store refuses — not an image, or too large to show — is the
    // person's to hear about, in the store's own words, and no turn is spent.
    let sent: SentImage[] = [];
    try {
      sent = (images ?? []).map((image) => {
        const held = store().put(image.data);
        return { id: held.id, mediaType: held.mediaType, data: image.data };
      });
    } catch (error) {
      if (isAppError(error) && error.category === 'contract') return error.message;
      throw error;
    }

    if (sent.length === 0 && text.trim() === NEW_CONVERSATION) {
      await startOver();
      log.info('a new conversation was asked for');
      return STARTED_OVER;
    }

    const message = sent.length === 0 ? text : { text, images: sent };
    const turn = async (): Promise<string> => {
      const talking = await ensureAgent();
      // The approver is whoever is on *this* connection, for this turn. An
      // agent outlives the connections to it.
      const exchange = await talking.say(message, approvalThrough(conversation));
      continuing = false;
      const token = talking.resumeToken;
      if (token !== null && runnerName !== null) {
        const saved = savedConversation();
        if (saved?.resume !== token || saved.runner !== runnerName) {
          await saveConversation(token, runnerName);
        }
      }
      return exchange.reply;
    };

    try {
      try {
        return await turn();
      } catch (error) {
        // The one failure that is a reason to start afresh: the provider no
        // longer has the conversation it was asked to continue — its files
        // gone, the machine replaced. The message is not lost; it is asked
        // again of a new conversation, once.
        if (!(continuing && isAppError(error) && error.code === 'resume-failed')) throw error;
        log.warn('the saved conversation could not be continued, so a new one is started', {
          reason: error.message,
        });
        await startOver();
        return await turn();
      }
    } catch (error) {
      // The person is waiting for a sentence. A missing provider is the one
      // failure they can act on themselves, so it reaches them as its own
      // message rather than as a stack trace.
      if (isAppError(error) && error.category === 'config') {
        if (!announced) {
          announced = true;
          log.warn('someone tried to talk and no provider is available', {
            reason: error.message,
          });
        }
        return error.message;
      }
      throw error;
    }
  };

  const channelComponent: Component = {
    name: 'channel',
    async start() {
      const opened = createChannel({
        dataDir: options.config.dataDir,
        logger: log,
        onSay: answer,
      });
      await opened.start();
      channel = opened;
    },
    async stop() {
      await channel?.stop();
      channel = null;
    },
    health() {
      if (channel === null) return { status: 'failing' as const, detail: 'not listening' };
      return { status: 'ok' as const, detail: `${channel.connections} connection(s)` };
    },
  };

  const telegramSettings = options.config.telegram;
  const components: Component[] = [agentComponent, channelComponent];
  if (telegramSettings !== undefined) {
    components.push(
      telegramComponent({
        allowedUserIds: telegramSettings.allowedUserIds,
        answer,
        log,
        ...(options.readCredential === undefined ? {} : { readCredential: options.readCredential }),
        open: options.openTelegram ?? createTelegramChannel,
        retryMs: options.telegramRetryMs ?? TELEGRAM_RETRY_MS,
      }),
    );
  }

  return {
    components,
    current: () => agent,
  };
}

interface TelegramParts {
  readonly allowedUserIds: readonly number[];
  readonly answer: (
    text: string,
    conversation: Conversation,
    images?: readonly IncomingImage[],
  ) => Promise<string>;
  readonly log: Logger;
  readonly readCredential?: ReadCredential;
  readonly open: (options: TelegramOptions) => TelegramChannel;
  readonly retryMs: number;
}

/**
 * The bot, as a component that comes up after the socket and goes down before it.
 *
 * ## Two kinds of failure at start, and they are treated oppositely
 *
 * **A credential that is missing, or a token Telegram refuses, stops the daemon.**
 * Both are configuration — the operator turned the bot on and something they
 * have to do is undone — and a daemon that came up without the channel it was
 * told to open would look like it was working. They exit as configuration
 * errors, which the unit does not restart, because restarting cannot fix them.
 *
 * **Telegram being unreachable does not.** CONCEPTS' second commitment is that a
 * failing part must not take the system with it, and a network that is down at
 * boot is the commonest failure there is. The socket still answers, the
 * component reports itself failing, and it tries again until Telegram answers.
 */
function telegramComponent(parts: TelegramParts): Component {
  const { log } = parts;
  let channel: TelegramChannel | null = null;
  let retry: NodeJS.Timeout | null = null;
  let stopped = false;
  /** Why it is not connected, while it is not. */
  let trouble: string | null = null;

  const connect = async (bot: TelegramChannel): Promise<void> => {
    try {
      await bot.start();
      trouble = null;
      // A stop that arrived while the connection was being made.
      if (stopped) await bot.stop();
    } catch (error) {
      if (!(isAppError(error) && error.category === 'unavailable')) throw error;
      trouble = error.message;
      if (stopped) return;
      log.warn('Telegram could not be reached, and will be tried again', {
        reason: error.message,
        retryMs: parts.retryMs,
      });
      retry = setTimeout(() => {
        retry = null;
        connect(bot).catch((later: unknown) => {
          // Not at boot any more, so there is no start to fail: the socket is
          // serving and this is said where an operator will look.
          trouble = isAppError(later) ? later.message : String(later);
          log.error('the Telegram channel gave up', { reason: trouble });
        });
      }, parts.retryMs);
    }
  };

  return {
    name: 'telegram',
    async start() {
      if (parts.readCredential === undefined) {
        throw new AppError('the Telegram channel is configured and nothing can read its token', {
          category: 'config',
          code: 'no-credential-reader',
        });
      }
      stopped = false;
      const bot = parts.open({
        token: parts.readCredential(TELEGRAM_TOKEN),
        allowedUserIds: parts.allowedUserIds,
        onSay: parts.answer,
        logger: log,
      });
      channel = bot;
      await connect(bot);
    },
    async stop() {
      stopped = true;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      await channel?.stop();
      channel = null;
    },
    health() {
      if (channel === null) return { status: 'failing' as const, detail: 'not started' };
      if (trouble !== null) return { status: 'failing' as const, detail: trouble };
      if (!channel.running) return { status: 'failing' as const, detail: 'not polling' };
      return {
        status: 'ok' as const,
        detail: `polling; ${channel.refused} update(s) from outside the allowlist dropped`,
      };
    },
  };
}
