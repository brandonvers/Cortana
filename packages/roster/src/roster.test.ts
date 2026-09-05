import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAppError } from '@cortana/core';
import { manualClock } from '@cortana/core/testing';
import { containmentFailures } from '@cortana/policy';
import {
  createWriter,
  migrateToLatest,
  openStorage,
  type Storage,
  type Writer,
} from '@cortana/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDefinition } from './definition.ts';
import { openRoster, profileFor, type Roster } from './roster.ts';
import { agents } from './schema.ts';

const MAIL = `+++
description = "Reads and triages the mailbox"
tier = "fast"
tools = ["Read"]
readable = ["/srv/mail"]
+++

You are the mail specialist. You are terse.
`;

let root: string;
let directory: string;
let storage: Storage;
let writer: Writer;
let roster: Roster;

const write = (name: string, source: string) => writeFileSync(join(directory, name), source);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-roster-'));
  directory = join(root, 'agents');
  mkdirSync(directory);
  storage = openStorage({ dataDir: join(root, 'state') });
  migrateToLatest(storage);
  writer = createWriter({ storage });
  roster = openRoster({ directory, storage, writer, clock: manualClock() });
});

afterEach(async () => {
  await writer.drain();
  storage.close();
  rmSync(root, { recursive: true, force: true });
});

describe('reading one definition', () => {
  it('takes the frontmatter as settings and the rest as the persona', () => {
    const definition = parseDefinition('mail', MAIL);

    expect(definition.name).toBe('mail');
    expect(definition.description).toBe('Reads and triages the mailbox');
    expect(definition.tier).toBe('fast');
    expect(definition.tools).toEqual(['Read']);
    expect(definition.persona).toBe('You are the mail specialist. You are terse.');
  });

  it('grants nothing that was not asked for', () => {
    // ADR-0021's allowlist, as a default rather than as a thing to remember.
    const definition = parseDefinition('bare', '+++\ndescription = "x"\n+++\nYou are bare.');

    expect(definition.tools).toEqual([]);
    expect(definition.readable).toEqual([]);
    expect(definition.confirm).toBe('writes');
    expect(definition.tier).toBe('balanced');
  });

  it('names the file and the field when a setting is wrong', () => {
    // "invalid roster" is not a message anybody can act on at the time they
    // read it, which is at midnight, in an editor, with one file open.
    const bad = '+++\ndescription = "x"\ntier = "enormous"\n+++\nYou are wrong.';

    expect(() => parseDefinition('wrong', bad, '/agents/wrong.md')).toSatisfy(
      (thrown: () => void) => {
        try {
          thrown();
          return false;
        } catch (error) {
          expect(isAppError(error)).toBe(true);
          expect((error as Error).message).toContain('/agents/wrong.md');
          expect((error as Error).message).toContain('tier');
          return true;
        }
      },
    );
  });

  it('refuses an unrecognised setting rather than ignoring it', () => {
    // A misspelled setting that silently does nothing is the worst outcome
    // available: the agent loads, looks configured, and behaves as though the
    // line was never written.
    const bad = '+++\ndescription = "x"\nmodell = "fast"\n+++\nYou.';

    expect(() => parseDefinition('typo', bad)).toThrow(/modell/);
  });

  it('refuses a file with nothing after the frontmatter', () => {
    expect(() => parseDefinition('empty', '+++\ndescription = "x"\n+++\n\n  \n')).toThrow(
      /nothing after the frontmatter/,
    );
  });

  it('refuses frontmatter that is never closed', () => {
    expect(() => parseDefinition('open', '+++\ndescription = "x"\nYou are unterminated.')).toThrow(
      /never closed/,
    );
  });

  it('insists the fence is the first thing in the file', () => {
    // Otherwise a stray fence in the middle of a persona could be read as
    // frontmatter, which is a very confusing way to lose the top of a prompt.
    expect(() => parseDefinition('late', '\n+++\ndescription = "x"\n+++\nYou.')).toThrow(
      /starts with a \+\+\+ line/,
    );
  });

  it('refuses a name that would not survive being a filename and a key', () => {
    expect(() => parseDefinition('Mail Agent', MAIL)).toThrow(/not a usable agent name/);
    expect(() => parseDefinition('a', MAIL)).toThrow(/not a usable agent name/);
  });

  it('says the frontmatter is not TOML rather than reporting every field missing', () => {
    expect(() => parseDefinition('broken', '+++\ndescription = \n+++\nYou.')).toThrow(
      /not valid TOML/,
    );
  });
});

describe('the roster', () => {
  it('is empty, not broken, when nothing has been authored', () => {
    const nowhere = openRoster({ directory: join(root, 'absent'), storage, writer });

    expect(nowhere.list()).toEqual([]);
    expect(nowhere.problems).toEqual([]);
  });

  it('lists what is on disk, dormant, without a row existing', () => {
    write('mail.md', MAIL);
    roster.reload();

    expect(roster.list()).toHaveLength(1);
    expect(roster.get('mail')?.state).toBe('dormant');
    expect(roster.get('mail')?.origin).toBe('authored');
  });

  it('ignores anything that is not a definition, silently', () => {
    // Silently is the point. A README beside your agents is not a broken agent,
    // and reporting it as one teaches people to stop reading the problem list —
    // which is where the actual broken agent will be.
    write('mail.md', MAIL);
    write('README.txt', 'not an agent');
    write('.hidden.md.swp', 'nor this');
    roster.reload();

    expect(roster.list().map((entry) => entry.definition.name)).toEqual(['mail']);
    expect(roster.problems).toEqual([]);
  });

  it('keeps running when one file is wrong, and says which', () => {
    // An operator editing one agent at midnight should get a daemon that runs
    // everything else and names the file, not a daemon that will not start.
    write('mail.md', MAIL);
    write('broken.md', 'this is not a definition at all');
    roster.reload();

    expect(roster.list().map((entry) => entry.definition.name)).toEqual(['mail']);
    expect(roster.problems).toHaveLength(1);
    expect(roster.problems[0]?.file).toContain('broken.md');
  });
});

describe('an agent the system created', () => {
  const invented = parseDefinition(
    'triage',
    '+++\ndescription = "Sorts enquiries"\n+++\nYou sort enquiries.',
  );

  it('is remembered, and appears beside the authored ones', async () => {
    write('mail.md', MAIL);
    roster.reload();

    await roster.remember(invented);

    expect(roster.list().map((entry) => entry.definition.name)).toEqual(['mail', 'triage']);
    expect(roster.get('triage')?.origin).toBe('created');
  });

  it('cannot take a name a file already has', async () => {
    // The collision the two-source split exists to keep impossible. A precedence
    // rule instead would mean an operator edits a file and nothing changes, for
    // a reason nothing tells them.
    write('mail.md', MAIL);
    roster.reload();
    const clash = parseDefinition('mail', '+++\ndescription = "other"\n+++\nSomething else.');

    await expect(roster.remember(clash)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'agent-name-taken',
    );
  });

  it('can be forgotten', async () => {
    await roster.remember(invented);
    await roster.forget('triage');

    expect(roster.get('triage')).toBeNull();
  });

  it('survives being written and read back', async () => {
    await roster.remember(invented);

    expect(roster.get('triage')?.definition).toEqual(invented);
  });
});

describe('what the roster will not do to your files', () => {
  it('refuses to forget an authored agent, row or no row', async () => {
    // The first version of this asked the row for the agent's origin, which
    // protected your files only once something had already woken them — and an
    // authored agent that has never been used has no row at all.
    write('mail.md', MAIL);
    roster.reload();

    await expect(roster.forget('mail')).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'agent-is-authored',
    );
  });

  it('never stores a copy of an authored definition', async () => {
    write('mail.md', MAIL);
    roster.reload();

    // A copy would be a second answer to "what is this agent", and the point of
    // the split is that there is one.
    const stored = storage.db.select().from(agents).all();
    expect(stored.filter((row) => row.origin === 'authored' && row.definition !== null)).toEqual(
      [],
    );
  });
});

describe('a row whose definition has gone', () => {
  it('is reported and unused, not deleted', async () => {
    write('mail.md', MAIL);
    roster.reload();
    await writer.write('pretend the file was there', ({ db }) => {
      db.insert(agents)
        .values({ name: 'gone', origin: 'authored', stateChangedAt: 1, createdAt: 1 })
        .run();
    });

    expect(roster.get('gone')).toBeNull();
    expect(roster.problems.map((problem) => problem.reason)).toContain(
      'this agent has a row but no definition file; the row is kept and unused',
    );
  });

  it('is reported when a created agent’s stored definition does not validate', async () => {
    // Written by this code, and checked anyway: a row from an older build is the
    // case that would otherwise arrive as a plausible object with a field
    // missing, and fail three layers away.
    await writer.write('an older build wrote this', ({ db }) => {
      db.insert(agents)
        .values({
          name: 'ancient',
          origin: 'created',
          definition: JSON.stringify({ name: 'ancient', persona: 'no description' }),
          stateChangedAt: 1,
          createdAt: 1,
        })
        .run();
    });

    expect(roster.get('ancient')).toBeNull();
    expect(roster.problems.some((problem) => problem.file.includes('ancient'))).toBe(true);
  });
});

describe('what an agent is allowed to do', () => {
  it('comes from its definition, through the generator', () => {
    const profile = profileFor(parseDefinition('mail', MAIL));

    expect(profile.name).toBe('mail');
    expect(profile.tools).toEqual(['Read']);
    expect(profile.readable).toEqual(['/srv/mail']);
    // Derived, so a definition granting a tool cannot also switch the sandbox off.
    expect(profile.sandbox).toBe('required');
    // And what the definition said about being asked, rather than a default
    // chosen here — an agent that silently never consults anybody is the whole
    // approval path quietly not existing.
    expect(profile.confirm).toBe('writes');
    expect(
      profileFor(parseDefinition('loud', '+++\ndescription = "x"\nconfirm = "always"\n+++\nYou.'))
        .confirm,
    ).toBe('always');
  });

  it('is a sandbox-free profile only when it can do nothing', () => {
    const bare = profileFor(parseDefinition('bare', '+++\ndescription = "x"\n+++\nYou.'));

    expect(bare.sandbox).toBe('none');
    expect(bare.tools).toEqual([]);
  });

  it('is never a contained one by accident', () => {
    // A working profile is supposed to be able to do things. This asserts the
    // roster does not quietly produce quarantine profiles, which would look like
    // an agent that exists and can never do anything.
    expect(containmentFailures(profileFor(parseDefinition('mail', MAIL)))).not.toEqual([]);
  });
});
