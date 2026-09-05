/**
 * Waking an agent, and putting it back.
 *
 * [ADR-0006](../../../docs/adr/0006-dormancy-is-the-default.md): "residency is
 * an identity, not a running process". An agent's default state is `dormant` —
 * its definition exists, no session does, and it costs nothing. This is the
 * thing that makes a roster of a dozen affordable, and the whole of it is
 * knowing when to open a session and when to close one.
 *
 * ## What dormancy costs, and why that is the interesting number
 *
 * [Spike 0003](../../../docs/spikes/0003-concurrent-sessions.md) measured it
 * against the alternative rather than in the abstract, which is the only
 * comparison that says anything: a *pre-warmed wake* against a *warm turn* on a
 * session that never slept. **−195 ms** on the realistic profile — the wake was
 * faster — and **+656 ms** at worst, on a cheap model where a cold prompt cache
 * is visible. The sign is model-dependent and the magnitude is a few hundred
 * milliseconds on a multi-second reply.
 *
 * So the cost is not the wake. It is the **cold start of 5.4–6.2 s** when
 * nothing pre-warmed it, which is what M6's presence engine is for and which
 * this milestone does not have. Until then a first message to a dormant agent is
 * slow, and that is a known, measured, temporary cost rather than a surprise.
 *
 * ## What an agent forgets when it sleeps
 *
 * Everything. ADR-0006 is explicit that "anything an agent must remember has to
 * be outside the session, in the memory system" and that "a dormant agent that
 * loses state was never really resident" — and **the memory system is M5**,
 * blocked on a corpus. So in M4 a resident's conversation ends when it sleeps.
 *
 * That is a real limitation and it is stated here rather than discovered: an
 * agent asked something five minutes after the idle TTL expired has no idea what
 * it was doing before. Setting a long TTL hides it and pays 264 MB per agent for
 * the privilege.
 *
 * ## Why there is a sweep and not a timer
 *
 * A timer per agent is a timer per agent to cancel, leak, or fire against a
 * session that has already gone. One sweep, called on an interval by whoever
 * owns the process, has a single ordering to reason about and can be driven by a
 * manual clock in a test — which is how the TTL is checked here at all.
 */

import { type Agent, createAgent, type Exchange } from '@cortana/agent';
import { AppError, type Clock, type Logger, systemClock } from '@cortana/core';
import type { Approve, ModelRunner } from '@cortana/runner';
import type { Writer } from '@cortana/storage';
import { ne } from 'drizzle-orm';
import type { AgentDefinition } from './definition.ts';
import { profileFor, type Roster } from './roster.ts';
import { type AgentRow, agents } from './schema.ts';

export type AgentState = AgentRow['state'];

export interface Resident {
  readonly name: string;
  readonly state: AgentState;
  /** The session, when there is one. Null while dormant, which is the default. */
  readonly session: string | null;
  /** Wakes it if it is asleep, then takes one turn. */
  say(text: string, approve?: Approve): Promise<Exchange>;
  sleep(reason: string): Promise<void>;
}

export interface ResidentsOptions {
  readonly roster: Roster;
  readonly runner: ModelRunner;
  readonly writer: Writer;
  /** How long an agent stays awake with nothing to do. */
  readonly idleTtlMs: number;
  /** How many may be awake at once. Tokens bind this, not memory. */
  readonly maxAwake: number;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

export interface Residents {
  /** Wakes an agent, or hands back the one that is already awake. */
  wake(name: string): Promise<Resident>;
  /** The one that is awake, or null. Never wakes anything. */
  awake(name: string): Resident | null;
  readonly count: number;
  /** Puts to sleep anything idle for longer than the TTL. Returns how many. */
  sweep(): Promise<number>;
  /** Puts everything to sleep. For shutdown. */
  close(): Promise<void>;
}

interface Live {
  readonly definition: AgentDefinition;
  readonly origin: AgentRow['origin'];
  agent: Agent | null;
  state: AgentState;
  /** When it last finished a turn, by the monotonic clock. */
  idleSince: number;
  /** In flight, so a second caller waits rather than opening a second session. */
  opening: Promise<Agent> | null;
  /** Turns running now. A sweep never sleeps an agent that is working. */
  busy: number;
}

/**
 * Everything the daemon holds awake, and the rules for how many.
 *
 * Nothing here is awake at construction. That is the design rather than
 * laziness: a roster of twelve dormant agents is twelve rows and no sessions.
 */
export function createResidents(options: ResidentsOptions): Residents {
  const clock = options.clock ?? systemClock;
  const log = options.logger?.child({ component: 'residents' });
  const live = new Map<string, Live>();

  /**
   * Records the state where something other than this process can see it.
   *
   * The row is for observers — the ops CLI, and M7's dashboard — rather than for
   * this code, which has the map above. It is reset at construction rather than
   * trusted on the way in, because a daemon that was killed left rows saying
   * `active` for sessions that died with it.
   */
  const record = async (entry: Live, state: AgentState): Promise<void> => {
    const now = clock.now();
    const name = entry.definition.name;
    await options.writer.write('record agent state', ({ db }) => {
      db.insert(agents)
        .values({
          name,
          // Carried rather than assumed. A created agent always has a row
          // already, so this branch only fires for an authored one — but
          // hard-coding that here is a fact stated in two places, and the other
          // place is the one that is true.
          origin: entry.origin,
          state,
          stateChangedAt: now,
          createdAt: now,
        })
        .onConflictDoUpdate({ target: agents.name, set: { state, stateChangedAt: now } })
        .run();
    });
  };

  const view = (entry: Live): Resident => ({
    name: entry.definition.name,
    get state() {
      return entry.state;
    },
    get session() {
      return entry.agent?.id ?? null;
    },
    say: (text, approve) => turn(entry, text, approve),
    sleep: (reason) => sleep(entry, reason),
  });

  const sleep = async (entry: Live, reason: string): Promise<void> => {
    const agent = entry.agent;
    entry.agent = null;
    entry.state = 'dormant';
    live.delete(entry.definition.name);
    await agent?.stop();
    await record(entry, 'dormant');
    log?.info('an agent went dormant', { agent: entry.definition.name, reason });
  };

  /**
   * Makes room, or explains why there is none.
   *
   * An idle agent is evicted rather than a wake being refused, because idle is
   * exactly the state dormancy exists to end. An **active** one is never
   * evicted: it is mid-turn, and taking its session away would fail a request
   * somebody is waiting for in order to start one they are not.
   */
  const makeRoom = async (except: string): Promise<void> => {
    // The agent being woken is already in the map — it has to be, so a second
    // caller in the same tick finds it instead of opening a second session — so
    // it is excluded from both the count and the candidates. Otherwise waking
    // something would evict it to make room for itself.
    const others = [...live.values()].filter((entry) => entry.definition.name !== except);
    if (others.length < options.maxAwake) return;

    const idle = others
      .filter((entry) => entry.busy === 0)
      .sort((a, b) => a.idleSince - b.idleSince)[0];

    if (idle === undefined) {
      throw new AppError(
        `${options.maxAwake} agents are awake and all of them are working, so there is no ` +
          'room to wake another',
        {
          category: 'unavailable',
          code: 'roster-full',
          detail: { awake: others.length, maxAwake: options.maxAwake },
        },
      );
    }
    await sleep(idle, 'made room for another agent');
  };

  const open = async (entry: Live): Promise<Agent> => {
    if (entry.agent !== null && !entry.agent.stopped) return entry.agent;
    if (entry.opening !== null) return entry.opening;

    // A `Resident` is a handle to a roster entry, not to a session, and `say`
    // promises to wake it if it is asleep. So one that slept — swept, or evicted
    // to make room — and is then spoken to comes back here, and has to be put
    // back on the register before it does: without this it would open a session
    // that `count` does not include, the sweep never looks at, and `close` never
    // stops. Awake and invisible is the worst of both.
    const name = entry.definition.name;
    if (live.get(name) !== entry) {
      live.set(name, entry);
      await makeRoom(name);
    }

    entry.opening = (async () => {
      entry.state = 'warming';
      await record(entry, 'warming');
      const agent = await createAgent({
        runner: options.runner,
        profile: profileFor(entry.definition),
        persona: entry.definition.persona,
        tier: entry.definition.tier,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      entry.agent = agent;
      // Awake with nothing to do is `idle`, not `warming`. Without this an agent
      // woken and not spoken to stayed `warming` for the rest of its life — a
      // state that means "a session is opening" long after one opened, and the
      // sweep only ever looks at `idle`, so it would never have slept either.
      entry.state = 'idle';
      entry.idleSince = clock.monotonic();
      await record(entry, 'idle');
      log?.info('an agent woke', { agent: entry.definition.name, session: agent.id });
      return agent;
    })();

    try {
      return await entry.opening;
    } catch (error) {
      // A failed wake must not leave the row saying `warming` forever, and must
      // not leave a rejected promise that every later caller awaits.
      entry.state = 'dormant';
      live.delete(entry.definition.name);
      await record(entry, 'dormant');
      throw error;
    } finally {
      entry.opening = null;
    }
  };

  const turn = async (entry: Live, text: string, approve?: Approve): Promise<Exchange> => {
    const agent = await open(entry);
    entry.busy += 1;
    entry.state = 'active';
    await record(entry, 'active');
    try {
      return await agent.say(text, approve);
    } finally {
      entry.busy -= 1;
      if (entry.busy === 0) {
        entry.idleSince = clock.monotonic();
        entry.state = 'idle';
        await record(entry, 'idle');
      }
    }
  };

  return {
    async wake(name) {
      const existing = live.get(name);
      if (existing !== undefined) {
        await open(existing);
        return view(existing);
      }

      const found = options.roster.get(name);
      if (found === null) {
        throw new AppError(`there is no agent called "${name}" on the roster`, {
          category: 'config',
          code: 'no-such-agent',
          detail: { name },
        });
      }

      const entry: Live = {
        definition: found.definition,
        origin: found.origin,
        agent: null,
        state: 'dormant',
        idleSince: clock.monotonic(),
        opening: null,
        busy: 0,
      };
      // Registered before the first `await`, and that ordering is the whole of
      // it: two callers waking the same agent in one tick both found nothing
      // here and both opened a session, at 264 MB each, and the second was
      // kept. The in-flight guard inside `open` cannot help when the caller
      // never reaches the same entry.
      live.set(name, entry);
      try {
        await makeRoom(name);
        await open(entry);
      } catch (error) {
        live.delete(name);
        throw error;
      }
      return view(entry);
    },

    awake(name) {
      const entry = live.get(name);
      return entry === undefined ? null : view(entry);
    },

    get count() {
      return live.size;
    },

    async sweep() {
      const deadline = clock.monotonic() - options.idleTtlMs;
      const stale = [...live.values()].filter(
        (entry) => entry.busy === 0 && entry.state === 'idle' && entry.idleSince <= deadline,
      );
      for (const entry of stale) await sleep(entry, 'idle for longer than the TTL');
      return stale.length;
    },

    async close() {
      for (const entry of [...live.values()]) await sleep(entry, 'the daemon is stopping');
    },
  };
}

/**
 * Puts every agent back to `dormant` in the database.
 *
 * Called once at boot, before anything reads a state. A daemon that was killed
 * left rows saying `active` for sessions that died with it, and an observer —
 * the ops CLI, M7's dashboard — would otherwise be told that agents are working
 * when nothing is. Spike 0005 made the same argument about leases: work held by
 * a process that died is reclaimed at boot rather than left stranded.
 */
export async function resetAgentStates(
  writer: Writer,
  clock: Clock = systemClock,
): Promise<number> {
  let changed = 0;
  await writer.write('reset agent states', ({ db }) => {
    changed = db
      .update(agents)
      .set({ state: 'dormant', stateChangedAt: clock.now() })
      // Only the rows that are lying. Touching every row would rewrite
      // `stateChangedAt` on agents that were already dormant, which is the one
      // column saying how long they have been.
      .where(ne(agents.state, 'dormant'))
      .run().changes;
  });
  return changed;
}
