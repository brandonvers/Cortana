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
 * ## The honest boundary of what is decided here
 *
 * `decide` runs against every action the agent *declares*. It does not run
 * against the tools the agent uses inside its own session — `Read`, `Bash` and
 * the rest execute inside the provider, and the port has no seam through which
 * a per-call decision could reach them.
 *
 * That is not a hole, because those tools are governed by the two layers
 * CONCEPTS §7 asks for: the profile rendered into the session's settings, where
 * a withheld tool is removed rather than gated
 * ([spike 0011](../../../docs/spikes/0011-quarantine-escape.md)), and the OS
 * sandbox. It is a **limit worth naming**, because "the policy engine decides
 * every tool call" would be a fair reading of the milestone and is not what this
 * does. Whether the port should grow such a seam is M3 step 4's question, and it
 * is not answered by pretending it already has one.
 */

import { AppError, type Logger, type SessionId } from '@cortana/core';
import { type Decision, decide, type Profile, type ToolRequest } from '@cortana/policy';
import type { ModelRunner, ModelTier, StructuredSession, TurnUsage } from '@cortana/runner';
import { composePrompt } from './prompt.ts';
import { type AgentAnswer, agentAnswer, type ToolIntent } from './schema.ts';

/** One declared action and what the policy engine said about it. */
export interface DecidedAction {
  readonly intent: ToolIntent;
  readonly decision: Decision;
}

/** Everything one `say` produced. */
export interface Exchange {
  /** What the person reads. */
  readonly reply: string;
  readonly actions: readonly DecidedAction[];
  readonly usage: TurnUsage;
}

export interface Agent {
  readonly id: SessionId;
  readonly profile: Profile;
  readonly stopped: boolean;
  /**
   * One turn. Resolves when the model has answered and every action it declared
   * has been decided.
   *
   * Concurrent calls are queued rather than refused or interleaved — see the
   * note on ordering below.
   */
  say(text: string): Promise<Exchange>;
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

  const session: StructuredSession<AgentAnswer> = await runner.startStructured(
    {
      tier,
      systemPrompt: composePrompt({ persona: options.persona, profile }),
      profile,
    },
    agentAnswer,
  );

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

  const runTurn = async (text: string): Promise<Exchange> => {
    if (session.stopped) {
      throw new AppError('this agent has stopped and will not take another turn', {
        category: 'unavailable',
        code: 'agent-stopped',
        detail: { session: session.id as string },
      });
    }

    const prompt = carried === null ? text : `${carried}\n\n${text}`;
    // Cleared before the turn rather than after it. A turn that throws has still
    // delivered the note, and carrying it into the retry as well would tell the
    // model twice about one refusal.
    carried = null;

    const result = await session.turn(prompt);

    const actions: DecidedAction[] = result.value.actions.map((intent) => ({
      intent,
      decision: decide(profile, asRequest(intent)),
    }));

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

    return { reply: result.value.reply, actions, usage: result.usage };
  };

  return {
    id: session.id,
    profile,
    get stopped() {
      return session.stopped;
    },

    say(text: string): Promise<Exchange> {
      const next = tail.then(() => runTurn(text));
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
