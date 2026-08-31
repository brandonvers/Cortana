/**
 * Test doubles for the ports in this package.
 *
 * This is a separate entry point rather than part of the main one so that
 * importing it from production code is a visible mistake rather than an
 * accident: `@cortana/core/testing` in a non-test file is obvious in review in a
 * way that one more name in a barrel file is not.
 */

import type { Clock } from './clock.ts';
import type { LogFields, Logger, LogMethod } from './logging.ts';

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

export interface RecordedEntry {
  readonly level: LogMethod;
  readonly message: string;
  readonly fields: LogFields;
}

export interface RecordingLogger extends Logger {
  readonly entries: readonly RecordedEntry[];
  /** Everything written, as one string. Convenient for "this must not appear". */
  text(): string;
}

/**
 * A logger that keeps what it was told instead of writing it anywhere.
 *
 * For tests that care what was logged, and — more often — for tests asserting
 * that something was **not** logged. It deliberately does no redaction of its
 * own: a test using it sees exactly what a caller passed, so a leak shows up
 * here rather than being hidden by the double that was meant to reveal it.
 */
export function recordingLogger(inherited: LogFields = {}): RecordingLogger {
  const entries: RecordedEntry[] = [];

  const make = (base: LogFields): RecordingLogger => {
    const record =
      (level: LogMethod) =>
      (message: string, fields: LogFields = {}) => {
        entries.push({ level, message, fields: { ...base, ...fields } });
      };

    return {
      entries,
      text: () => JSON.stringify(entries),
      child: (fields: LogFields) => make({ ...base, ...fields }),
      trace: record('trace'),
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      fatal: record('fatal'),
    };
  };

  return make(inherited);
}
