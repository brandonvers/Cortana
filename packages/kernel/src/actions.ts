/**
 * Actions the kernel runs for the agent — the first time anything the agent
 * asks for has an effect.
 *
 * Until working material's step 4, an action the agent declared was decided
 * by the policy engine and then dropped: the decision was recorded and nothing
 * happened. Here the kernel runs what was allowed, and a wrong action stops
 * being a sentence and becomes an effect. Three rules follow from that, and
 * each is checked by a test.
 *
 * - **An action says what it touches.** `writes` and `network` are part of the
 *   action, and they are what the policy engine decides on; the model's own
 *   account of its intent is not consulted for them.
 * - **An action's input is checked by the action.** It arrives as JSON in a
 *   string, is parsed, and is validated against the action's schema; input it
 *   rejects is refused before anything runs.
 * - **An action always comes back with a sentence.** Whatever happens inside —
 *   bad input, a failure, a thrown error — the agent is told in words, so the
 *   person hears what happened rather than nothing.
 */

import type { ActionDescription } from '@cortana/agent';
import { isAppError, type Logger } from '@cortana/core';
import type { MediaStore } from '@cortana/media';
import type { ZodType } from 'zod';

/** How many times one message may go round: ask, run, tell, ask again. */
export const MAX_ACTION_ROUNDS = 3;

/** What an action is handed besides its input. */
export interface ActionContext {
  /** Where its inputs are found by id, and where what it makes is kept. */
  readonly store: MediaStore;
  readonly log: Logger;
}

/** What an action did: a sentence for the agent, and the ids of anything it made. */
export interface ActionResult {
  readonly summary: string;
  readonly files?: readonly string[];
}

export interface KernelAction<Input = unknown> extends ActionDescription {
  readonly schema: ZodType<Input>;
  run(input: Input, context: ActionContext): Promise<ActionResult>;
}

export interface Performed {
  readonly name: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly files: readonly string[];
}

/** One decided action, run — and its outcome as a sentence, whatever it was. */
export async function perform(
  action: KernelAction,
  input: string,
  context: ActionContext,
): Promise<Performed> {
  const failed = (summary: string): Performed => ({
    name: action.name,
    ok: false,
    summary,
    files: [],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return failed('its input was not JSON, so it did not run');
  }
  const valid = action.schema.safeParse(parsed);
  if (!valid.success) {
    const issue = valid.error.issues[0];
    const where =
      issue === undefined || issue.path.length === 0 ? '' : ` at ${issue.path.join('.')}`;
    return failed(
      `its input did not fit${where}: ${issue?.message ?? 'invalid'}, so it did not run`,
    );
  }

  try {
    const result = await action.run(valid.data, context);
    return { name: action.name, ok: true, summary: result.summary, files: result.files ?? [] };
  } catch (error) {
    // An AppError is written to be read; anything else is a defect, described
    // to the log and only named to the agent.
    if (isAppError(error)) return failed(error.message);
    context.log.error('an action failed', { action: action.name, error: String(error) });
    return failed('it failed, and the details are in the log');
  }
}

/** What the agent is told after its actions ran, as the next message it reads. */
export function resultsMessage(results: readonly Performed[]): string {
  const lines = results.map(
    (result) => `- ${result.name}: ${result.ok ? 'done' : 'not done'} — ${result.summary}`,
  );
  const made = results.flatMap((result) => result.files);
  return [
    '[What the kernel did with the actions you asked for:',
    ...lines,
    made.length === 0
      ? 'Nothing was made.'
      : `Made: ${made.join(', ')}. These are sent with your reply; you need not attach them.`,
    'Now answer the person.]',
  ].join('\n');
}
