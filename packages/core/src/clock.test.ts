import { describe, expect, it } from 'vitest';
import { systemClock } from './clock.ts';
import { manualClock } from './testing.ts';

describe('systemClock', () => {
  it('reads a plausible wall clock', () => {
    // Loose on purpose: this asserts the reading is an epoch millisecond value
    // rather than seconds or a monotonic reading, which are the mistakes that
    // actually happen. It is not a test of the machine's clock accuracy.
    const now = systemClock.now();

    expect(now).toBeGreaterThan(Date.parse('2025-01-01T00:00:00Z'));
    expect(now).toBeLessThan(Date.parse('2100-01-01T00:00:00Z'));
  });

  it('never reports the monotonic reading going backwards', () => {
    const readings = Array.from({ length: 200 }, () => systemClock.monotonic());

    expect([...readings].sort((a, b) => a - b)).toEqual(readings);
  });

  it('keeps the two readings separate', () => {
    // If someone implements monotonic() as Date.now(), durations start depending
    // on NTP. The two origins differ by decades, so this catches it.
    expect(Math.abs(systemClock.now() - systemClock.monotonic())).toBeGreaterThan(1e9);
  });
});

describe('manualClock', () => {
  it('does not move on its own', () => {
    const clock = manualClock();
    const before = clock.now();

    for (let i = 0; i < 1_000; i++) clock.monotonic();

    expect(clock.now()).toBe(before);
    expect(clock.monotonic()).toBe(0);
  });

  it('moves both readings when advanced', () => {
    const clock = manualClock(1_700_000_000_000);

    clock.advance(250);
    clock.advance(750);

    expect(clock.now()).toBe(1_700_000_001_000);
    expect(clock.monotonic()).toBe(1_000);
  });

  it('refuses to go backwards', () => {
    const clock = manualClock();

    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(clock.monotonic()).toBe(0);
  });
});
