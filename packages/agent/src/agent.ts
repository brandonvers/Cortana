/**
 * The one agent: a session, a loop, and a decision on everything it asks for.
 *
 * ## What it depends on, and the two things it deliberately does not
 *
 * The M3 plan listed `audit` and `bus` among this package's dependencies. It has
 * neither, and both absences are the plan being improved rather than ignored.
 *
 * **The audit wraps the runner, not the agent.** `auditedRunner` returns a
 * `ModelRunner`, so an agent handed an audited one records every turn without
 * containing a line about auditing — which is the property that wrapper exists
 * for. Importing the audit here would let somebody construct an agent over a
 * bare runner and get a conversation that happened and was never written down.
 * Taking a port and being unable to tell whether it is wrapped is the design.
 *
 * **The bus has nothing to carry yet.** M3 has one agent and no subscribers.
 * A dependency added for an event nobody consumes is a guess about M6 made in
 * M3, and ADR-0011's typed bus is exactly the thing that makes such a guess
 * expensive to correct.
 *
 * ## Both paths reach the same policy engine, and that is new
 *
 * An earlier version of this file said the opposite, and said it carefully: the
 * policy engine decided the actions the agent *declared*, and the tools it used
 * inside its own session were governed only by the rendered settings and the
 * sandbox, because "the port has no seam through which a per-call decision could
 * reach them". That was true, it was named rather than hidden, and step 4 found
 * the limit was worse than the paragraph admitted — the settings layer could
 * only withhold tool names this repository had heard of, and a quarantine
 * session was measured using one it had not.
 *
 * The port has that seam now. Both paths run `decideForSession` against the same
 * profile, and both reach the same person through the same `approve`. What is
 * left of the earlier caveat is only this: the two paths are decided in two
 * places — one here, one in the adapter's gate — because one of them happens
 * inside the provider. They cannot be one function, so they are one policy.
 */

import { AppError, type Logger, type SessionId } from '@cortana/core';
import { type Decision, decideForSession, type Profile, type ToolRequest } from '@cortana/policy';
import type {
  Approve,
  ModelRunner,
  ModelTier,
  StructuredSession,
  TurnImage,
  TurnUsage,
} from '@cortana/runner';
import { composePrompt } from './prompt.ts';
import { type AgentAnswer, agentAnswer, type ToolIntent } from './schema.ts';

/** One declared action and what the policy engine said about it. */
export interface DecidedAction {
  readonly intent: ToolIntent;
  readonly decision: Decision;
}

/**
 * An image the person sent, as the agent is handed it: the bytes the model is
 * shown, and the id the system holds it under.
 *
 * The id is what makes it usable after this turn. The model is told it, so a
 * later turn — or a tool, from a later step — can refer to this picture by the
 * name the store gave it, and never by a path.
 */
export interface SentImage extends TurnImage {
  readonly id: string;
}

/** A message with something attached to it. */
export interface Message {
  readonly text: string;
  readonly images: readonly SentImage[];
}

/** Everything one `say` produced. */
export interface Exchange {
  /** What the person reads. */
  readonly reply: string;
  readonly actions: readonly DecidedAction[];
  /** Ids the agent asked to send with the reply. Unchecked here: the store is what knows. */
  readonly attachments: readonly string[];
  readonly usage: TurnUsage;
}

export interface Agent {
  readonly id: SessionId;
  readonly profile: Profile;
  readonly stopped: boolean;
  /**
   * What continues this conversation in a later process, or null before the
   * first turn — the session's own token, passed through unchanged.
   */
  readonly resumeToken: string | null;
  /**
   * One turn. Resolves when the model has answered and every action it declared
   * has been decided.
   *
   * Concurrent calls are queued rather than refused or interleaved — see the
   * note on ordering below.
   *
   * `approve` is **whoever is asking, this turn**, and it overrides the one the
   * agent was built with. An agent outlives the connections to it: the person
   * who opened the socket an hour ago is not necessarily the person waiting for
   * this answer, and a session's own approver is fixed when the session opens
   * and cannot be. Passing it per turn is what lets a question reach the person
   * who caused it rather than the one who happened to be first.
   */
  say(message: string | Message, approve?: Approve): Promise<Exchange>;
  /** Idempotent, like the session it closes. */
  stop(): Promise<void>;
}

export interface AgentOptions {
  /**
   * Where turns come from.
   *
   * Wrap it in `auditedRunner` before handing it over if the conversation is
   * meant to be recorded. This package cannot tell, and that is on purpose.
   */
  readonly runner: ModelRunner;
  readonly profile: Profile;
  /** Who this agent is. The only part of the prompt a person writes. */
  readonly persona: string;
  readonly tier?: ModelTier;
  /**
   * A token from an earlier session of this runner, to carry on its
   * conversation. The runner's to interpret; see `SessionSpec.resume`.
   */
  readonly resume?: string;
  /**
   * How a call the profile will not decide alone is put to a person.
   *
   * Passed to the session as well as used here, so that **both** paths reach the
   * same person: the tools the model uses inside its session, and the actions it
   * asks the kernel for. Two approval routes with different answers would be a
   * worse failure than one route, because only one of them would be the one
   * anybody tested.
   *
   * Absent means nobody is available, and a question nobody can answer is a
   * refusal.
   */
  readonly approve?: Approve;
  readonly logger?: Logger;
}

/**
 * How a refused action is reported back to the agent, on its next turn.
 *
 * Refusals are carried forward rather than corrected in place, and the choice is
 * worth stating because the other option is defensible. A correction turn — tell
 * the model what was refused, ask again, return the second answer — gives the
 * person a reply that never mentions something that did not happen. It also
 * spends a turn on every refusal, at a price spike 0009 measured varying 34×,
 * and it can be made to loop by a model that keeps proposing the same thing.
 *
 * Carrying forward costs nothing and cannot loop. It is honest in M3 because
 * nothing executes actions here: the caller receives the decisions alongside the
 * reply and can show both, so a reply that says "I will read that file" arrives
 * next to a refusal saying it did not. The moment something does execute them,
 * that reasoning stops holding and this is the paragraph to come back to.
 */
function refusalNote(refused: readonly DecidedAction[]): string {
  const lines = refused.map(
    (action) =>
      `- ${action.intent.tool}${action.intent.path === null ? '' : ` on ${action.intent.path}`}: ` +
      action.decision.because,
  );
  return [
    'Before this message: the kernel refused some of what you asked for last turn.',
    ...lines,
    'Do not propose them again unchanged. Say so plainly if it means you cannot do',
    'what was asked.',
  ].join('\n');
}

/** The agent's declaration, as the policy engine's question. */
function asRequest(intent: ToolIntent): ToolRequest {
  return {
    tool: intent.tool,
    ...(intent.path === null ? {} : { path: intent.path }),
    writes: intent.writes,
    network: intent.network,
  };
}

export async function createAgent(options: AgentOptions): Promise<Agent> {
  const { runner, profile } = options;
  const log = options.logger?.child({ component: 'agent' });
  const tier = options.tier ?? 'balanced';

  /**
   * Who to ask during the turn that is running now.
   *
   * The session below is opened once and its approver is fixed for its life, so
   * the stable function it gets reads this instead. Safe because turns are
   * serialised: exactly one turn is in flight, so exactly one answer to "who is
   * asking" is current. The queue was there before this and is now load-bearing
   * for a second reason.
   */
  let asking: Approve | undefined = options.approve;

  const session: StructuredSession<AgentAnswer> = await runner.startStructured(
    {
      tier,
      systemPrompt: composePrompt({ persona: options.persona, profile }),
      profile,
      // Always supplied, and not conditional on there being anybody: with
      // nobody, `asking` is undefined and this refuses. Passing no approver at
      // all would mean the adapter refuses instead, which is the same answer
      // reached somewhere the reason is harder to find.
      approve: async (request, decision) => (await asking?.(request, decision)) ?? false,
      ...(options.resume === undefined ? {} : { resume: options.resume }),
    },
    agentAnswer,
  );

  /**
   * Turns an `ask` into the answer, or into a refusal when there is nobody.
   *
   * The question is **built here, from the tool and the path**, and deliberately
   * not from the agent's own `why`. That field is written by a model, it is
   * shown to a person, and a person reading a sentence composed by the thing
   * asking permission is the shape of every convincing request that should not
   * have been granted. The agent's reason travels in the `because` alongside it,
   * attributed, rather than as the question itself.
   */
  const settle = async (request: ToolRequest, decision: Decision): Promise<Decision> => {
    if (decision.verdict !== 'ask') return decision;

    const approve = asking;
    if (approve === undefined) {
      return { verdict: 'deny', because: `${decision.because}, and nobody is available to ask` };
    }

    return (await approve(request, decision))
      ? { verdict: 'allow', because: 'approved by the operator' }
      : { verdict: 'deny', because: 'refused by the operator' };
  };

  /** What the next turn has to be told about the last one. Empty most turns. */
  let carried: string | null = null;

  /**
   * Turns run one at a time, in the order they were asked for.
   *
   * A conversation is a sequence and the state above is per-turn, so two
   * overlapping calls would interleave a refusal note into the wrong prompt.
   * Queueing rather than refusing because the second caller is a person at a
   * socket — possibly a second terminal — and "you are talking too fast" is a
   * worse answer than waiting. The provider's own input queue serialises the
   * turns underneath this; what this adds is ordering the state alongside them.
   */
  let tail: Promise<unknown> = Promise.resolve();

  const runTurn = async (message: Message, approve: Approve | undefined): Promise<Exchange> => {
    asking = approve ?? options.approve;
    if (session.stopped) {
      throw new AppError('this agent has stopped and will not take another turn', {
        category: 'unavailable',
        code: 'agent-stopped',
        detail: { session: session.id as string },
      });
    }

    const text = withImageList(message);
    const prompt = carried === null ? text : `${carried}\n\n${text}`;
    // Cleared before the turn rather than after it. A turn that throws has still
    // delivered the note, and carrying it into the retry as well would tell the
    // model twice about one refusal.
    carried = null;

    const result = await session.turn(prompt, message.images);

    // Decided one at a time, and asked about one at a time. `decideForSession`
    // rather than `decide` because the profile's own answer to "should a person
    // see this first" is part of the decision, and a caller reaching for the
    // boundary alone gets an agent that never asks anybody anything — which is
    // not a mistake visible from outside.
    const actions: DecidedAction[] = [];
    for (const intent of result.value.actions) {
      const request = asRequest(intent);
      const decision = decideForSession(profile, request);
      actions.push({ intent, decision: await settle(request, decision) });
    }

    const refused = actions.filter((action) => action.decision.verdict !== 'allow');
    if (refused.length > 0) {
      carried = refusalNote(refused);
      // Counts, and nothing the model wrote. The obvious thing to log here is
      // the reason, and the reason names the path — `decide` writes "cannot read
      // /etc/shadow" precisely so an operator can act on it. That sentence is
      // right where it goes, and a log file is not where it goes: the path came
      // out of a model's declaration, which may be echoing whatever the person
      // typed, and logs outlive the conversation and get shipped somewhere.
      //
      // The content already has a home. ADR-0019 put it in the audit, the
      // caller receives every decision in the exchange, and neither of those is
      // a file that gets tailed into a terminal. So the log says how many, and
      // says where to look.
      log?.info('the policy engine refused actions the agent asked for', {
        session: session.id as string,
        refused: refused.length,
        of: actions.length,
      });
    }

    return {
      reply: result.value.reply,
      actions,
      attachments: result.value.attachments,
      usage: result.usage,
    };
  };

  return {
    id: session.id,
    profile,
    get stopped() {
      return session.stopped;
    },
    get resumeToken() {
      return session.resumeToken;
    },

    say(input: string | Message, approve?: Approve): Promise<Exchange> {
      const message = typeof input === 'string' ? { text: input, images: [] } : input;
      // Captured now and applied when the turn runs, not when it was asked for.
      // A queued turn belongs to whoever asked for it, however long it waited.
      const next = tail.then(() => runTurn(message, approve));
      // The queue must not break on a failed turn, so what is chained on is a
      // promise that settles rather than the one handed back. Without this, one
      // rejection would leave every later `say` rejecting with an error from a
      // turn its caller never asked for.
      tail = next.catch(() => undefined);
      return next;
    },

    stop(): Promise<void> {
      return session.stop();
    },
  };
}

/**
 * The text of a message, with the images that came with it named after it.
 *
 * The model sees the pictures themselves; what it cannot see is what the system
 * calls them. Naming them here is what lets the next turn say "the second
 * photo" in a way a tool can act on — the id — rather than a description that
 * has to be matched back to a file by guesswork.
 */
function withImageList(message: Message): string {
  if (message.images.length === 0) return message.text;
  const list = message.images
    .map((image, at) => `  ${at + 1}. ${image.id} (${image.mediaType})`)
    .join('\n');
  const sent = message.images.length === 1 ? 'one image' : `${message.images.length} images`;
  const text = message.text.trim() === '' ? '(no text, only the images)' : message.text;
  return `${text}\n\n[Sent with this message: ${sent}, held under these ids:\n${list}]`;
}
