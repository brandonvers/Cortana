/**
 * The last few inches: a decision that needs a person, and a person on a socket.
 *
 * `@cortana/runner` defines what an approval *is* — a function that takes a
 * request and a decision and settles with a yes or a no. `@cortana/channel`
 * knows where the person is. This is the one function that joins them, and it
 * lives here because the channel already owns everything about talking to
 * somebody: the socket, the timeout, and what a disconnection means.
 *
 * ## The question is composed here, from facts
 *
 * Not from anything a model wrote. A person approving a call is reading a
 * sentence, and if the thing asking permission also writes the sentence then the
 * approval step has been handed to the party it exists to check. So the question
 * is the tool and the path, and the policy engine's own words travel beside it
 * as the reason.
 */

import type { Decision, ToolRequest } from '@cortana/policy';
import type { Conversation } from './server.ts';

/**
 * Describes one call in the shortest sentence that is still specific.
 *
 * A path is included whole rather than shortened. An approval prompt that
 * elides the middle of a path is an approval prompt that reads the same for two
 * different files, and the difference between them is the entire question.
 */
export function questionFor(request: ToolRequest): string {
  const verb = request.writes === true ? 'write' : 'use';
  const target = request.path === undefined ? '' : ` on ${request.path}`;
  const reach = request.network === true ? ', reaching the network' : '';
  return `The agent wants to ${verb} ${request.tool}${target}${reach}. Allow it?`;
}

/**
 * An approval that asks whoever is connected.
 *
 * `Conversation.ask` already guarantees the part that matters most: it resolves
 * `false` on a refusal, on a disconnection, and on silence. So nothing here
 * needs a timeout of its own, and nothing here can wedge the daemon — which is
 * a property of that method rather than of this function, and the reason this
 * one is three lines.
 */
export function approvalThrough(conversation: Conversation) {
  return async (request: ToolRequest, decision: Decision): Promise<boolean> =>
    conversation.ask(questionFor(request), decision.because);
}
