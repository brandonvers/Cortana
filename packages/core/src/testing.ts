/**
 * Test doubles for the ports in this package.
 *
 * This is a separate entry point rather than part of the main one so that
 * importing it from production code is a visible mistake rather than an
 * accident: `@cortana/core/testing` in a non-test file is obvious in review in a
 * way that one more name in a barrel file is not.
 */

import type { Clock } from './clock.ts';

export interface ManualClock extends Clock {
  /** Moves both readings forward by `ms`. Negative values are rejected. */
  advance(ms: number): void;
}

/**
 * A clock that only moves when a test moves it.
 *
 * Wall-clock and monotonic readings advance together here, which is the
 * *simple* case rather than the interesting one. A test that needs to prove
 * something survives the wall clock jumping — the reason `Clock` separates the
 * two at all — has to move them independently, and should build the double it
 * needs rather than reaching for this one.
 */
export function manualClock(startEpochMs = 1_700_000_000_000): ManualClock {
  let epoch = startEpochMs;
  let elapsed = 0;
  return {
    now: () => epoch,
    monotonic: () => elapsed,
    advance: (ms: number) => {
      if (ms < 0) throw new RangeError(`a manual clock cannot go backwards: ${ms}`);
      epoch += ms;
      elapsed += ms;
    },
  };
}
