/**
 * The shape of everything the agent says.
 *
 * ## Why there is only one shape
 *
 * The main agent has two jobs — answer a person, and hand the kernel something
 * it can act on — and they look like they need two output formats. The port
 * says otherwise: [M2 found](../../runner/src/port.ts) that a session's output
 * shape is fixed for its life, because the provider has no way to change it
 * afterwards. Two shapes would mean two sessions, at the 263 MB each
 * [spike 0003](../../../docs/spikes/0003-concurrent-sessions.md) measured, and
 * the deciding one would not have heard the conversation it was deciding about.
 *
 * So the M3 plan chose the arrangement
 * [ADR-0015](../../../docs/adr/0015-structured-output-at-the-model-boundary.md)
 * already describes: **the agent always returns a value, and what a person reads
 * is a field of it.** Free text stays "the content of a message to the user,
 * never the carrier of a decision".
 *
 * ## Why every optional thing here is representable rather than omitted
 *
 * ADR-0015 records a measurement that shaped this file more than any other:
 * against four adversarial schemas, **the schema rather than the content decided
 * the response, in both directions**. A closed object dropped true facts to fit
 * its single field. A required non-nullable field was filled because it could
 * not be left empty.
 *
 * The remedy it measured is cheap and it is used everywhere below: **make
 * absence representable**. `path` is nullable because a tool call that touches
 * no path is ordinary. `actions` is a list because the empty list is the answer
 * on almost every turn, and a field with no way to say "none" is a field that
 * invents one.
 */

import { z } from 'zod';

/**
 * Something the agent wants the kernel to do on its behalf.
 *
 * The field names match `ToolRequest` in `@cortana/policy` deliberately: this is
 * the same question, asked by a model rather than by code, and a translation
 * layer between them would be a place for the two to drift apart.
 *
 * **What this is not.** It is not the tools the agent uses inside its own
 * session. Those are `Read`, `Bash` and the rest, they run inside the provider,
 * and the kernel does not see them one by one — they are governed by the profile
 * rendered into the session's settings and by the OS sandbox, which are the two
 * layers CONCEPTS §7 requires and neither of which is this. Nothing here widens
 * that; this is the separate, narrower channel for work the agent is asking the
 * kernel itself to do.
 */
export const toolIntent = z.object({
  tool: z.string().min(1).describe('The name of the tool, exactly as the kernel knows it.'),
  path: z
    .string()
    .nullable()
    .describe(
      'The absolute path this would touch, or null when it touches no path. ' +
        'A relative path cannot be checked and will be refused, so give a full one or null.',
    ),
  writes: z.boolean().describe('Whether this would modify what it touches.'),
  network: z.boolean().describe('Whether this would reach the network.'),
  why: z
    .string()
    .min(1)
    .describe('One sentence a person can act on, because a person may be asked to approve this.'),
  /**
   * What the action is given, as JSON in a string.
   *
   * A string rather than an object because each action has its own shape, and
   * one answer schema has to carry all of them: the action's own schema checks
   * it when it runs, and a value it rejects is refused before anything happens.
   * Defaulted, so an intent written before inputs existed means none.
   */
  input: z
    .string()
    .default('{}')
    .describe(
      'The action\'s input as a JSON object, written as a string. "{}" when it takes none.',
    ),
});

export type ToolIntent = z.infer<typeof toolIntent>;

/**
 * One answer: what the person reads, and what the agent wants done.
 *
 * `reply` is not permitted to be empty and `actions` is permitted to be. That
 * asymmetry is the whole design in one line — there is always something to say
 * to the person, and usually nothing to ask the kernel for.
 */
export const agentAnswer = z.object({
  reply: z
    .string()
    .min(1)
    .describe('What the person reads. Ordinary prose, and never a decision in disguise.'),
  actions: z
    .array(toolIntent)
    .describe(
      'What you want the kernel to do on your behalf. ' +
        'An empty list is the ordinary answer; never invent one to fill this field.',
    ),
  /**
   * Files to send with the reply, by the ids the system gave them.
   *
   * Ids and never paths, for the reason the media store gives: a path a model
   * chose is a path someone can talk it into. An id the store does not hold is
   * not sent, and the person is told. Defaulted, so an answer that leaves it
   * out — and every scripted answer written before it existed — means none.
   */
  attachments: z
    .array(z.string().min(1))
    .default([])
    .describe(
      'Ids of files you were given — exactly as written — to send with the reply. ' +
        'An empty list is the ordinary answer; never invent or guess an id.',
    ),
});

export type AgentAnswer = z.infer<typeof agentAnswer>;
