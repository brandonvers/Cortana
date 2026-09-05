/**
 * What an agent is, and the file it is written in.
 *
 * ## Why the frontmatter is TOML and not YAML
 *
 * YAML frontmatter between `---` markers is the convention, and it is the one
 * this project does not use, for two reasons that both point the same way.
 *
 * The configuration file is already TOML. An operator who has written
 * `config.toml` should not have to hold a second syntax in their head to write
 * an agent, and `+++` is the established marker for TOML frontmatter rather than
 * something invented here.
 *
 * And it costs no dependency: `smol-toml` is already in this tree. YAML would be
 * a new one, in a package that parses **files a module may ship**, and YAML's
 * implicit typing has a long history of reading a value as something other than
 * what was written. A format where `no` is a string is the safer one to hand an
 * agent definition to.
 *
 * ## Why the name comes from the filename
 *
 * A name written in two places drifts, and then one of them is wrong in a way
 * nothing detects: the file says `mail`, the frontmatter says `mailbox`, and a
 * delegation to either works or does not depending on which one the code read.
 * The filename is also what an operator sees in a directory listing, so it is
 * the copy that is hardest to forget about.
 *
 * ## Why the field list is short
 *
 * The M4 plan's own risk note: "the definition file format is an interface the
 * moment anybody writes one", so it is narrow on the first pass and grows by
 * adding fields. Everything deferred below is deferred because it has nothing
 * behind it yet — `memory` has no memory to scope (M5), `effort` has no
 * measurement, `skills` and `mcpServers` have no module host (M7). A field that
 * parses and does nothing is worse than an absent one, because it reads as a
 * setting.
 */

import { AppError } from '@cortana/core';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

/** What separates the frontmatter from the persona. */
const FENCE = '+++';

/**
 * The name an agent is addressed by.
 *
 * Constrained because it becomes a filename, a database key, and a string the
 * main agent writes into a delegation. Lower case with hyphens is the smallest
 * set that survives all three without anybody having to think about escaping.
 */
export const AGENT_NAME = /^[a-z][a-z0-9-]{1,39}$/;

const frontmatter = z.strictObject({
  /**
   * What this agent is for, in one line.
   *
   * Required, and the one field a person cannot leave out, because it is what
   * the main agent reads when it decides who should do something. An agent with
   * no description is an agent that never gets chosen, which looks like the
   * roster being broken rather than the file being incomplete.
   */
  description: z.string().min(1),
  tier: z.enum(['fast', 'balanced', 'deep']).default('balanced'),
  /** What it may reach for. Empty unless said otherwise — ADR-0021's allowlist. */
  tools: z.array(z.string().min(1)).default([]),
  readable: z.array(z.string()).default([]),
  writable: z.array(z.string()).default([]),
  confirm: z.enum(['never', 'writes', 'always']).default('writes'),
});

export type Frontmatter = z.infer<typeof frontmatter>;

/**
 * A whole definition, as a value rather than as a file.
 *
 * Two things read a definition: a file, and a database row holding one the
 * system created. This is what both produce, and it is validated in both
 * directions — a row written by an older build is a value that crossed a
 * boundary this process does not control the other side of, and ADR-0015 has
 * already settled how those are treated.
 */
export const agentDefinition = frontmatter.extend({
  name: z.string().regex(AGENT_NAME),
  /** The persona: everything after the frontmatter, which is the system prompt. */
  persona: z.string().min(1),
});

export type AgentDefinition = z.infer<typeof agentDefinition>;

const problem = (message: string, detail: Record<string, string | number>): AppError =>
  new AppError(message, { category: 'config', code: 'agent-definition-invalid', detail });

/**
 * Splits a definition file into its two halves.
 *
 * The opening fence must be the **first** thing in the file. A file that begins
 * with a blank line and then `+++` is far more likely to be a mistake than an
 * intention, and accepting it would mean a stray fence in the middle of a
 * persona could be read as frontmatter.
 */
function split(source: string, where: string): { frontmatter: string; persona: string } {
  const text = source.startsWith('﻿') ? source.slice(1) : source;
  if (!text.startsWith(`${FENCE}\n`) && !text.startsWith(`${FENCE}\r\n`)) {
    throw problem(
      `${where}: an agent definition starts with a ${FENCE} line, then TOML, then another ` +
        `${FENCE}, then the agent's persona`,
      { file: where },
    );
  }

  const body = text.slice(text.indexOf('\n') + 1);
  const end = body.indexOf(`\n${FENCE}`);
  if (end === -1) {
    throw problem(`${where}: the frontmatter is never closed — no second ${FENCE} line`, {
      file: where,
    });
  }

  const after = body.slice(end + FENCE.length + 1);
  return { frontmatter: body.slice(0, end), persona: after.replace(/^\r?\n/, '') };
}

/**
 * Reads one agent definition, or explains what is wrong with it.
 *
 * Every failure names the file, and every failure that is about one setting
 * names the setting. M4's definition of done asks for that in as many words: a
 * bad definition should not survive to first use, and "invalid roster" is not a
 * message anybody can act on at the time they read it.
 */
export function parseDefinition(name: string, source: string, where = name): AgentDefinition {
  if (!AGENT_NAME.test(name)) {
    throw problem(
      `${where}: "${name}" is not a usable agent name — lower case letters, digits and ` +
        'hyphens, starting with a letter, 2 to 40 characters',
      { file: where, name },
    );
  }

  const halves = split(source, where);

  let table: unknown;
  try {
    table = parseToml(halves.frontmatter);
  } catch (error) {
    throw problem(`${where}: the frontmatter is not valid TOML — ${String(error)}`, {
      file: where,
    });
  }

  const parsed = frontmatter.safeParse(table);
  if (!parsed.success) {
    // The field, not just the file. Zod's path is the only part of this a person
    // can act on without opening the schema.
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(top level)'}: ${issue.message}`)
      .join('; ');
    throw problem(`${where}: ${issues}`, { file: where, issues: parsed.error.issues.length });
  }

  const persona = halves.persona.trim();
  if (persona === '') {
    throw problem(
      `${where}: there is nothing after the frontmatter. An agent's persona is the text ` +
        'below it, and it is the whole of what the agent is',
      { file: where },
    );
  }

  return { name, ...parsed.data, persona };
}
