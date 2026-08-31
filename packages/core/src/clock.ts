/**
 * Time, as a port rather than a global.
 *
 * There are two reasons for this and only one of them is testability.
 *
 * The first is that **wall-clock time and elapsed time are different
 * quantities**, and using one for the other is a defect that only appears when
 * something adjusts the clock. `Date.now()` can jump — forwards or backwards —
 * when NTP corrects it or a daylight-saving change lands, so a deadline computed
 * by subtracting two `Date.now()` readings can expire instantly or never. That
 * matters in M1 for exactly one thing, the shutdown deadline, and it matters far
 * more in M5 where leases and backoff are made of durations.
 *
 * The second is that time-dependent behaviour tested against the real clock
 * produces slow tests that fail occasionally, which is the combination that
 * teaches people to re-run a suite instead of reading it.
 *
 * **This abstraction is on probation.** M1 has three time-dependent behaviours
 * in total, which is thin justification. It is here because M5 cannot avoid
 * needing it and retrofitting it then touches every package, while adding it now
 * costs a few lines in the package that has no dependencies. If M5 arrives and
 * it has not earned its place, delete it rather than keep it — see
 * `docs/milestones/m1-kernel-skeleton.md`.
 */

export interface Clock {
  /**
   * Milliseconds since the Unix epoch.
   *
   * For anything a person or another system will read: log timestamps, audit
   * records, "when did this happen". **Never for measuring how long something
   * took** — it is allowed to jump.
   */
  now(): number;

  /**
   * A millisecond reading that never goes backwards, from an arbitrary origin.
   *
   * The absolute value is meaningless; only differences between two readings
   * are. Use it for every deadline, timeout, and duration.
   */
  monotonic(): number;
}

/**
 * The clock that reads the machine.
 *
 * `performance.now()` rather than a Node-specific timer, because it is a
 * standard API and `docs/adr/0008-nodejs-runtime.md` asks that a standard one be
 * used where it does the job.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
};
