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

import { type Agent, createAgent } from '@cortana/agent';
import { auditedRunner } from '@cortana/audit';
import { approvalThrough, type Channel, createChannel } from '@cortana/channel';
import type { Config } from '@cortana/config';
import { AppError, type InstanceId, isAppError, type Logger } from '@cortana/core';
import { workingProfile } from '@cortana/policy';
import type { ModelRunner } from '@cortana/runner';
import type { Writer } from '@cortana/storage';
import type { Component } from './lifecycle.ts';

/** Opens the model runner this daemon will use. Supplied by whoever picks one. */
export type OpenRunner = () => Promise<ModelRunner>;

export interface ConversationOptions {
  readonly config: Config;
  readonly logger: Logger;
  readonly writer: Writer;
  readonly instanceId: InstanceId;
  /** Absent when nothing has chosen a provider, which is a supported state. */
  readonly openRunner?: OpenRunner;
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
      const started = await createAgent({
        runner,
        profile,
        persona: options.config.agent.persona,
        tier: options.config.agent.tier,
        logger: log,
      });
      agent = started;
      log.info('the agent is awake', { session: started.id, profile: profile.name });
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

  const channelComponent: Component = {
    name: 'channel',
    async start() {
      const opened = createChannel({
        dataDir: options.config.dataDir,
        logger: log,
        onSay: async (text, conversation) => {
          try {
            const talking = await ensureAgent();
            // The approver is whoever is on *this* connection, for this turn.
            // An agent outlives the connections to it.
            const exchange = await talking.say(text, approvalThrough(conversation));
            return exchange.reply;
          } catch (error) {
            // The person is at a terminal waiting for a sentence. A missing
            // provider is the one failure they can act on themselves, so it
            // reaches them as its own message rather than as a stack trace.
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
        },
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

  return {
    components: [agentComponent, channelComponent],
    current: () => agent,
  };
}
