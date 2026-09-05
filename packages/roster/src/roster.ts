/**
 * The roster: who exists, from both places, kept apart.
 *
 * Two sources with one rule between them. Files are read and never written; the
 * database is written and never holds a copy of a file. A name that appears in
 * both is a mistake rather than a merge, and it is reported as one — because the
 * alternative is a precedence rule, and a precedence rule means an operator
 * edits a file and nothing changes for a reason nothing tells them.
 *
 * ## What this does not do yet
 *
 * Nothing runs. There are no sessions here, no waking, no delegation — a roster
 * is a list of who could be asked, and M4 step 2 is what makes one of them
 * awake. `state` is read and reported and not yet moved by anything.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { AppError, type Clock, systemClock } from '@cortana/core';
import { type Profile, workingProfile } from '@cortana/policy';
import type { Storage, Writer } from '@cortana/storage';
import { eq } from 'drizzle-orm';
import { type AgentDefinition, agentDefinition, parseDefinition } from './definition.ts';
import { type AgentRow, agents } from './schema.ts';

/** The extension an agent definition has. */
const SUFFIX = '.md';

export type AgentState = AgentRow['state'];
export type AgentOrigin = AgentRow['origin'];

export interface RosterEntry {
  readonly definition: AgentDefinition;
  readonly origin: AgentOrigin;
  readonly state: AgentState;
}

/**
 * A definition file that could not be read, kept rather than thrown.
 *
 * One bad file must not take the roster down with it: an operator editing the
 * mail agent at midnight should get a daemon that runs everything else and says
 * which file is wrong, not a daemon that will not start. The failure is loud —
 * every one of these is logged at boot — and it is survivable.
 */
export interface RosterProblem {
  readonly file: string;
  readonly reason: string;
}

export interface Roster {
  /** Everyone who could be asked to do something, authored and created alike. */
  list(): readonly RosterEntry[];
  get(name: string): RosterEntry | null;
  /** What the definitions that could not be read were, and why. */
  readonly problems: readonly RosterProblem[];
  /**
   * Adds an agent the system created, and gives it a row of its own.
   *
   * The path CONCEPTS §3.1 calls promotion: "a state change rather than a
   * rewrite". Refuses a name an authored file already has, because that is the
   * collision the whole two-source split exists to keep impossible.
   */
  remember(definition: AgentDefinition): Promise<void>;
  /** Forgets a created agent. Refuses to touch an authored one. */
  forget(name: string): Promise<void>;
  /** Re-reads the directory. Everything created stays where it is. */
  reload(): void;
}

export interface RosterOptions {
  /** Where authored definitions live. A missing directory is an empty roster. */
  readonly directory: string;
  readonly storage: Storage;
  readonly writer: Writer;
  readonly clock?: Clock;
}

/** Turns a definition into what the session it runs in may do. */
export function profileFor(definition: AgentDefinition): Profile {
  return workingProfile({
    name: definition.name,
    tools: definition.tools,
    readable: definition.readable,
    writable: definition.writable,
    confirm: definition.confirm,
  });
}

interface Authored {
  readonly definitions: Map<string, AgentDefinition>;
  readonly problems: RosterProblem[];
}

function readDirectory(directory: string): Authored {
  const definitions = new Map<string, AgentDefinition>();
  const problems: RosterProblem[] = [];

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    // No directory is an empty roster, not an error. A daemon with no agents
    // authored yet is the ordinary first run.
    return { definitions, problems };
  }

  for (const entry of entries.sort()) {
    if (extname(entry) !== SUFFIX) continue;
    const file = join(directory, entry);
    try {
      const definition = parseDefinition(basename(entry, SUFFIX), readFileSync(file, 'utf8'), file);
      definitions.set(definition.name, definition);
    } catch (error) {
      problems.push({ file, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { definitions, problems };
}

export function openRoster(options: RosterOptions): Roster {
  const clock = options.clock ?? systemClock;
  let authored = readDirectory(options.directory);

  const rows = (): AgentRow[] => options.storage.db.select().from(agents).all();

  /**
   * The definition on a created agent's row, validated rather than trusted.
   *
   * This code wrote it, and it is checked anyway. It crossed a boundary this
   * process does not control the other side of — a file on disk, written by
   * some build — and a row from an older one is exactly the case that would
   * otherwise arrive as a plausible object with a field missing and fail three
   * layers away. It is the same argument ADR-0015 makes about the provider's
   * schema enforcement, applied to our own.
   *
   * A row that fails is skipped and reported rather than thrown, for the reason
   * a bad file is: one unreadable agent must not take the roster down.
   */
  const created = (row: AgentRow): AgentDefinition | null => {
    if (row.origin !== 'created' || row.definition === null) return null;
    try {
      const parsed = agentDefinition.safeParse(JSON.parse(row.definition));
      return parsed.success && parsed.data.name === row.name ? parsed.data : null;
    } catch {
      return null;
    }
  };

  const entries = (): RosterEntry[] => {
    const byName = new Map<string, AgentRow>();
    for (const row of rows()) byName.set(row.name, row);

    const out: RosterEntry[] = [];
    for (const definition of authored.definitions.values()) {
      out.push({
        definition,
        origin: 'authored',
        state: byName.get(definition.name)?.state ?? 'dormant',
      });
    }
    for (const row of byName.values()) {
      if (authored.definitions.has(row.name)) continue;
      const definition = created(row);
      if (definition === null) continue;
      out.push({ definition, origin: 'created', state: row.state });
    }
    return out.sort((a, b) => a.definition.name.localeCompare(b.definition.name));
  };

  return {
    list: entries,
    get: (name) => entries().find((entry) => entry.definition.name === name) ?? null,

    get problems() {
      const stale = rows().flatMap((row) => {
        if (row.origin === 'authored' && !authored.definitions.has(row.name)) {
          return [
            {
              file: `${join(options.directory, row.name)}${SUFFIX}`,
              // Not deleted. The row is where the agent's state lives, and an
              // agent whose file is temporarily gone — a rename, a half-finished
              // edit, a checkout — should not lose what it was doing.
              reason: 'this agent has a row but no definition file; the row is kept and unused',
            },
          ];
        }
        if (row.origin === 'created' && created(row) === null) {
          return [
            {
              file: `the database row for ${row.name}`,
              reason: 'this created agent’s stored definition did not validate, so it is unused',
            },
          ];
        }
        return [];
      });
      return [...authored.problems, ...stale];
    },

    async remember(definition) {
      if (authored.definitions.has(definition.name)) {
        throw new AppError(
          `"${definition.name}" is already an agent you authored, and a created one cannot ` +
            'take the same name',
          {
            category: 'config',
            code: 'agent-name-taken',
            detail: { name: definition.name },
          },
        );
      }

      const now = clock.now();
      await options.writer.write('remember an agent', ({ db }) => {
        db.insert(agents)
          .values({
            name: definition.name,
            origin: 'created',
            definition: JSON.stringify(definition),
            state: 'dormant',
            stateChangedAt: now,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: agents.name,
            set: { definition: JSON.stringify(definition) },
          })
          .run();
      });
    },

    async forget(name) {
      // Asked of the directory, not of the row. A row is where an agent's state
      // lives and an authored agent may not have one yet — so checking the row's
      // `origin` protected your files only once something had already woken
      // them, which is the wrong half of the time.
      if (authored.definitions.has(name)) {
        throw new AppError(`"${name}" is authored in a file, and this cannot delete your files`, {
          category: 'config',
          code: 'agent-is-authored',
          detail: { name },
        });
      }
      await options.writer.write('forget an agent', ({ db }) => {
        db.delete(agents).where(eq(agents.name, name)).run();
      });
    },

    reload() {
      authored = readDirectory(options.directory);
    },
  };
}
