import { describe, expect, it } from 'vitest';
import type { Brand, InstanceId, Uuid } from './ids.ts';
import { newInstanceId, timestampOf, uuidV7 } from './ids.ts';

const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('brands', () => {
  // These assertions are made by the typechecker, not by vitest: `tsc --noEmit`
  // covers this file, and an unused @ts-expect-error is itself an error. So if
  // the brand ever stops distinguishing types, this fails the build rather than
  // quietly passing.
  type AgentId = Brand<string, 'AgentId'>;
  type JobId = Brand<string, 'JobId'>;

  it('does not let one identifier stand in for another', () => {
    const agent = 'a' as AgentId;

    // @ts-expect-error an AgentId is not a JobId, however alike they look
    const job: JobId = agent;

    expect(job).toBe('a');
  });

  it('does not let a bare string become an identifier', () => {
    // @ts-expect-error minting an identifier has to be deliberate
    const agent: AgentId = 'a';

    expect(agent).toBe('a');
  });

  it('still reads as the underlying type', () => {
    const agent = 'a' as AgentId;
    const asString: string = agent;

    expect(asString.toUpperCase()).toBe('A');
  });
});

describe('uuidV7', () => {
  it('is canonical, version 7, and variant 10x', () => {
    const id = uuidV7();

    expect(id).toMatch(CANONICAL);
    expect(id[14]).toBe('7');
    expect('89ab').toContain(id[19]);
  });

  it('carries the millisecond it was minted', () => {
    const when = 1_767_225_600_123;

    expect(timestampOf(uuidV7(when))).toBe(when);
  });

  it('sorts as text in the order it was minted', () => {
    const times = [1_700_000_000_000, 1_700_000_000_001, 1_700_000_060_000, 1_800_000_000_000];
    const ids = times.map((t) => uuidV7(t));

    expect([...ids].sort()).toEqual(ids);
  });

  it('survives the timestamp crossing a 32-bit boundary', () => {
    // The layout writes six bytes by division rather than by bit shifting,
    // because JavaScript's bitwise operators truncate to 32 bits and the epoch
    // in milliseconds passed that in 1970. A shift-based implementation returns
    // a plausible-looking id here with the top bytes wrong.
    for (const when of [0, 1, 0xff_ff_ff_ff, 0x1_00_00_00_00, 1_767_225_600_123]) {
      expect(timestampOf(uuidV7(when))).toBe(when);
    }
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 5_000 }, () => uuidV7(1_700_000_000_000)));

    expect(seen.size).toBe(5_000);
  });

  it('orders identifiers minted within the same millisecond', () => {
    // This was not always true, and the trigger for changing it was written
    // down: "if bursts of same-millisecond writes ever need a stable order".
    // M2's audit is that burst — three turns against a fake adapter landed in
    // one millisecond and came back out of order, and an identifier meant to be
    // the cursor for "what happened since" cannot be ordered by something with
    // ties.
    const ids = Array.from({ length: 20_000 }, () => uuidV7(1_700_000_000_000));

    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(20_000);
  });

  it('does not degrade to inversions under a burst', () => {
    // The first attempt used RFC 9562's small dedicated counter, twelve bits in
    // rand_a. It runs out after a few thousand, and once it saturates the
    // remaining 62 random bits decide the comparison — so ordering did not
    // degrade to ties but to inversions: 335 of 2,000 came out before the one
    // they followed. Incrementing the whole random field has 2^74 of headroom
    // instead of 2^12.
    const ids = Array.from({ length: 50_000 }, () => uuidV7(1_700_000_000_000));
    const inversions = ids.filter((id, index) => index > 0 && id < (ids[index - 1] as string));

    expect(inversions).toEqual([]);
  });

  it('starts a fresh sequence when asked for an older instant', () => {
    // A test minting at a fixed past instant is a legitimate use, and it must
    // not inherit a sequence from wherever the process had got to.
    uuidV7(1_800_000_000_000);
    const older = uuidV7(1_700_000_000_000);

    expect(timestampOf(older)).toBe(1_700_000_000_000);
  });

  it('reads the timestamp back as null from anything that is not a version 7 uuid', () => {
    const v4 = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' as Uuid;

    expect(timestampOf(v4)).toBeNull();
    expect(timestampOf('' as Uuid)).toBeNull();
    expect(timestampOf('not-a-uuid' as Uuid)).toBeNull();
  });
});

describe('newInstanceId', () => {
  it('mints a version 7 uuid typed as an InstanceId', () => {
    const id: InstanceId = newInstanceId(1_700_000_000_000);

    expect(id).toMatch(CANONICAL);
    expect(timestampOf(id as string as Uuid)).toBe(1_700_000_000_000);
  });
});
