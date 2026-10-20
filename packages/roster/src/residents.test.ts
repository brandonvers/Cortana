import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAppError } from '@cortana/core';
import { type ManualClock, manualClock, recordingLogger } from '@cortana/core/testing';
import { fakeRunner } from '@cortana/runner/testing';
import {
  createWriter,
  migrateToLatest,
  openStorage,
  type Storage,
  type Writer,
} from '@cortana/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createResidents, type Residents, resetAgentStates } from './residents.ts';
import { openRoster, type Roster } from './roster.ts';
import { agents } from './schema.ts';

const definition = (name: string) =>
  `+++\ndescription = "does ${name} things"\n+++\nYou are the ${name} specialist.\n`;

const answer = (reply: string) => ({ reply, actions: [] });

let root: string;
let directory: string;
let storage: Storage;
let writer: Writer;
let roster: Roster;
let clock: ManualClock;

const TTL = 300_000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-residents-'));
  directory = join(root, 'agents');
  mkdirSync(directory);
  for (const name of ['mail', 'research', 'writer']) {
    writeFileSync(join(directory, `${name}.md`), definition(name));
  }
  storage = openStorage({ dataDir: join(root, 'state') });
  migrateToLatest(storage);
  writer = createWriter({ storage });
  clock = manualClock();
  roster = openRoster({ directory, storage, writer, clock });
});

afterEach(async () => {
  await writer.drain();
  storage.close();
  rmSync(root, { recursive: true, force: true });
});

const residentsOf = (values: unknown[], maxAwake = 4) => {
  const runner = fakeRunner({ values });
  const residents = createResidents({
    roster,
    runner,
    writer,
    idleTtlMs: TTL,
    maxAwake,
    clock,
    logger: recordingLogger(),
  });
  return { runner, residents };
};

const stateOf = (name: string) =>
  storage.db
    .select()
    .from(agents)
    .all()
    .find((row) => row.name === name)?.state;

describe('an agent nobody has asked for', () => {
  it('holds no session', async () => {
    // ADR-0006: residency is an identity, not a running process. A roster of
    // three dormant agents is three files and no sessions.
    const { runner, residents } = residentsOf([]);

    expect(residents.count).toBe(0);
    expect(residents.awake('mail')).toBeNull();
    expect(runner.sessions).toBe(0);
  });
});

describe('waking one', () => {
  it('opens a session and answers', async () => {
    const { runner, residents } = residentsOf([answer('sorted your mail')]);

    const resident = await residents.wake('mail');
    const exchange = await resident.say('anything in the inbox?');

    expect(exchange.reply).toBe('sorted your mail');
    expect(runner.sessions).toBe(1);
    expect(resident.session).not.toBeNull();
  });

  it('runs it under the profile its definition asks for', async () => {
    const { runner, residents } = residentsOf([answer('ok')]);
    await residents.wake('mail');

    // Not a profile chosen here. A definition that granted a tool would have to
    // be honoured, and one that grants none has to leave the session with none.
    expect(runner.opened[0]?.profile.name).toBe('mail');
    expect(runner.opened[0]?.profile.tools).toEqual([]);
    expect(runner.opened[0]?.systemPrompt).toContain('You are the mail specialist.');
  });

  it('hands back the same session when it is already awake', async () => {
    const { runner, residents } = residentsOf([answer('one'), answer('two')]);

    const first = await residents.wake('mail');
    const second = await residents.wake('mail');
    await first.say('a');
    await second.say('b');

    expect(runner.sessions).toBe(1);
    expect(residents.count).toBe(1);
  });

  it('opens one session when two callers wake it in the same tick', async () => {
    const { runner, residents } = residentsOf([answer('one')]);

    await Promise.all([residents.wake('mail'), residents.wake('mail')]);

    expect(runner.sessions).toBe(1);
  });

  it('refuses a name that is not on the roster', async () => {
    const { residents } = residentsOf([]);

    await expect(residents.wake('nobody')).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'no-such-agent',
    );
  });

  it('tries again after a re-open fails, rather than repeating one rejection', async () => {
    // The path: an agent is awake, its session ends, and the next turn has to
    // re-open. If that fails and the in-flight promise is not cleared, the
    // `Resident` handed out earlier closes over an entry holding a rejected
    // promise — and every later turn on it fails with an error from an attempt
    // its caller never made.
    let opens = 0;
    const runner = fakeRunner({ values: [answer('first'), answer('second')] });
    const residents = createResidents({
      roster,
      runner: {
        ...runner,
        startStructured: async (spec, schema) => {
          opens += 1;
          if (opens === 2) throw new Error('the provider blinked');
          return runner.startStructured(spec, schema);
        },
      },
      writer,
      idleTtlMs: TTL,
      maxAwake: 4,
      clock,
    });

    const resident = await residents.wake('mail');
    await resident.sleep('the sweep got to it');

    // Re-opening fails once, and then must be allowed to fail differently.
    await expect(resident.say('hello')).rejects.toThrow(/blinked/);
    await expect(resident.say('hello again')).resolves.toMatchObject({ reply: 'first' });
  });

  it('puts a re-woken agent back on the register', async () => {
    // Otherwise it is awake and invisible: not in `count`, never swept, never
    // stopped by `close` — a session the daemon holds and does not know about.
    const { runner, residents } = residentsOf([answer('one'), answer('two')]);
    const resident = await residents.wake('mail');
    await resident.sleep('the sweep got to it');
    expect(residents.count).toBe(0);

    await resident.say('are you there?');

    expect(residents.count).toBe(1);
    expect(residents.awake('mail')).not.toBeNull();
    expect(runner.sessions).toBe(2);
  });

  it('leaves nothing behind when waking fails', async () => {
    // A failed wake must not leave a row saying `warming` forever, nor a
    // rejected promise every later caller awaits.
    const broken = createResidents({
      roster,
      runner: {
        name: 'broken',
        start: async () => {
          throw new Error('the provider is unreachable');
        },
        startStructured: async () => {
          throw new Error('the provider is unreachable');
        },
        usage: async () => null,
      },
      writer,
      idleTtlMs: TTL,
      maxAwake: 4,
      clock,
    });

    await expect(broken.wake('mail')).rejects.toThrow(/unreachable/);

    expect(broken.count).toBe(0);
    expect(stateOf('mail')).toBe('dormant');
  });
});

describe('what the database is told', () => {
  it('follows the agent through its states', async () => {
    // The row is for observers — the ops CLI, M7's dashboard — rather than for
    // this code, which has the map. It has to be true while nothing is reading it.
    const { residents } = residentsOf([answer('ok')]);

    // No flush anywhere below: every state write is awaited by the call that
    // caused it, which is the ordering ADR-0017 asks for — durable before
    // acknowledged — and it is why an observer reading this table while the
    // daemon runs sees the truth rather than the recent past.
    const resident = await residents.wake('mail');
    expect(stateOf('mail')).toBe('idle');

    await resident.say('do something');
    expect(stateOf('mail')).toBe('idle');

    await resident.sleep('done');
    expect(stateOf('mail')).toBe('dormant');
  });

  it('is reset at boot, because a killed daemon left rows saying active', async () => {
    await writer.write('a daemon that died mid-turn', ({ db }) => {
      db.insert(agents)
        .values({
          name: 'mail',
          origin: 'authored',
          state: 'active',
          stateChangedAt: 1,
          createdAt: 1,
        })
        .run();
      db.insert(agents)
        .values({
          name: 'research',
          origin: 'authored',
          state: 'warming',
          stateChangedAt: 1,
          createdAt: 1,
        })
        .run();
    });

    const reset = await resetAgentStates(writer, clock);

    expect(reset).toBe(2);
    expect(stateOf('mail')).toBe('dormant');
  });

  it('leaves an already dormant row alone, including when it changed', async () => {
    // stateChangedAt is the one column saying how long an agent has been asleep,
    // and rewriting it on every boot would make that always "since this boot".
    await writer.write('a tidy shutdown', ({ db }) => {
      db.insert(agents)
        .values({
          name: 'mail',
          origin: 'authored',
          state: 'dormant',
          stateChangedAt: 42,
          createdAt: 1,
        })
        .run();
    });

    expect(await resetAgentStates(writer, clock)).toBe(0);
    expect(
      storage.db
        .select()
        .from(agents)
        .all()
        .find((row) => row.name === 'mail')?.stateChangedAt,
    ).toBe(42);
  });
});

describe('the sweep', () => {
  it('sleeps an agent idle for longer than the TTL', async () => {
    const { residents } = residentsOf([answer('ok')]);
    const resident = await residents.wake('mail');
    await resident.say('hello');

    clock.advance(TTL + 1);

    expect(await residents.sweep()).toBe(1);
    expect(residents.count).toBe(0);
    expect(residents.awake('mail')).toBeNull();
  });

  it('leaves one that is still within it', async () => {
    const { residents } = residentsOf([answer('ok')]);
    const resident = await residents.wake('mail');
    await resident.say('hello');

    clock.advance(TTL - 1);

    expect(await residents.sweep()).toBe(0);
    expect(residents.count).toBe(1);
  });

  it('never sleeps an agent that is working', async () => {
    // The failure this prevents is taking a session away mid-turn from somebody
    // who is waiting for the answer.
    const runner = fakeRunner({ values: [answer('slow')] });
    const residents = createResidents({
      roster,
      runner: {
        ...runner,
        startStructured: async (spec, schema) => {
          const session = await runner.startStructured(spec, schema);
          return {
            ...session,
            get stopped() {
              return session.stopped;
            },
            turn: async (prompt: string) => {
              clock.advance(TTL * 2);
              await residents.sweep();
              return session.turn(prompt);
            },
          };
        },
      },
      writer,
      idleTtlMs: TTL,
      maxAwake: 4,
      clock,
    });

    const resident = await residents.wake('mail');
    await expect(resident.say('take your time')).resolves.toMatchObject({ reply: 'slow' });
    expect(residents.count).toBe(1);
  });
});

describe('the cap on how many are awake', () => {
  it('evicts the one idle longest to make room', async () => {
    const { residents } = residentsOf([answer('a'), answer('b'), answer('c')], 2);

    const mail = await residents.wake('mail');
    await mail.say('first');
    clock.advance(1_000);
    const research = await residents.wake('research');
    await research.say('second');

    await residents.wake('writer');

    // `mail` went idle first, so it is the one that sleeps. An idle agent is
    // exactly what dormancy exists to end.
    expect(residents.awake('mail')).toBeNull();
    expect(residents.awake('research')).not.toBeNull();
    expect(residents.count).toBe(2);
  });

  it('refuses rather than interrupting agents that are all working', async () => {
    const runner = fakeRunner({ values: [answer('a'), answer('b')] });
    const holding = new Map<string, () => void>();

    const residents: Residents = createResidents({
      roster,
      runner: {
        ...runner,
        startStructured: async (spec, schema) => {
          const session = await runner.startStructured(spec, schema);
          return {
            ...session,
            get stopped() {
              return session.stopped;
            },
            turn: async (prompt: string) => {
              await new Promise<void>((resolve) => holding.set(spec.profile.name, resolve));
              return session.turn(prompt);
            },
          };
        },
      },
      writer,
      idleTtlMs: TTL,
      maxAwake: 1,
      clock,
    });

    const mail = await residents.wake('mail');
    const inFlight = mail.say('working');
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(residents.wake('research')).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'roster-full',
    );

    holding.get('mail')?.();
    await inFlight;
  });
});

describe('stopping', () => {
  it('puts everything to sleep', async () => {
    const { residents } = residentsOf([answer('a'), answer('b')]);
    await residents.wake('mail');
    await residents.wake('research');

    await residents.close();

    expect(residents.count).toBe(0);
    expect(stateOf('mail')).toBe('dormant');
    expect(stateOf('research')).toBe('dormant');
  });
});
