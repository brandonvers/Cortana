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
