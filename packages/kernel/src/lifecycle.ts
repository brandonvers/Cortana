/**
 * Starting things in order, stopping them in the reverse order, and being honest
 * about what a deadline can and cannot do.
 *
 * Three properties this exists to guarantee, each of which is a way systems of
 * this shape usually go wrong:
 *
 * **A half-started system never runs.** If the fourth component fails to start,
 * the three already running are stopped, in reverse, before the failure is
 * reported. Otherwise a failed start leaves a database open, a queue accepting
 * work, and nobody supervising any of it.
 *
 * **One component failing to stop does not strand the rest.** Failures are
 * collected and reported together; the sequence continues.
 *
 * **The deadline bounds the wait, not the work.** JavaScript cannot interrupt a
 * `stop()` that will not return — there is no preemption, and pretending
 * otherwise would be the most dangerous kind of comfort. So when the budget runs
 * out, the remaining components are **not** stopped and are reported as not
 * reached, rather than being closed underneath something that is still using
 * them. Nothing is lost by that: ADR-0017 makes every acknowledged write durable
 * before the acknowledgement, so an unclean stop costs a WAL replay on the next
 * start and nothing else.
 */

import { AppError, type Clock, type Logger, systemClock } from '@cortana/core';

export type HealthStatus = 'ok' | 'degraded' | 'failing';

export interface Health {
  readonly status: HealthStatus;
  readonly detail?: string;
}

export interface Component {
  readonly name: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  /** Optional. A component without one is reported as `ok` and says so. */
  health?(): Health | Promise<Health>;
}

export type LifecycleState = 'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface ComponentOutcome {
  readonly name: string;
  readonly outcome: 'stopped' | 'failed' | 'timed-out' | 'not-reached';
  readonly error?: unknown;
  readonly ms?: number;
}

export interface StopReport {
  readonly reason: string;
  readonly clean: boolean;
  readonly ms: number;
  readonly components: readonly ComponentOutcome[];
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly components: readonly { readonly name: string; readonly health: Health }[];
}

export interface LifecycleOptions {
  readonly components: readonly Component[];
  readonly logger: Logger;
  /** How long the whole stop sequence may take. */
  readonly stopTimeoutMs: number;
  readonly clock?: Clock;
}

export interface Lifecycle {
  start(): Promise<void>;
  /** Idempotent: a second call returns the first call's report. */
  stop(reason: string): Promise<StopReport>;
  health(): Promise<HealthReport>;
  readonly state: LifecycleState;
}

const WORST: Record<HealthStatus, number> = { ok: 0, degraded: 1, failing: 2 };

/** Resolves to `null` if `promise` has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<{ ok: true; value: T } | null> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    const result = await Promise.race([
      promise.then((value) => ({ ok: true as const, value })),
      expired,
    ]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createLifecycle(options: LifecycleOptions): Lifecycle {
  const clock = options.clock ?? systemClock;
  const log = options.logger.child({ component: 'lifecycle' });
  const components = [...options.components];

  let state: LifecycleState = 'created';
  const started: Component[] = [];
  let stopReport: Promise<StopReport> | null = null;

  async function rollback(failed: Component, error: unknown): Promise<never> {
    log.error('a component failed to start; stopping what had already started', {
      component: failed.name,
      started: started.map((entry) => entry.name),
    });

    for (const component of [...started].reverse()) {
      try {
        await component.stop();
      } catch (stopError) {
        // Reported and swallowed: the start failure is the one worth raising,
        // and a rollback failure must not replace it.
        log.error('a component also failed while rolling back a failed start', {
          component: component.name,
          error: String(stopError),
        });
      }
    }
    started.length = 0;
    state = 'failed';

    throw new AppError(`the component "${failed.name}" failed to start`, {
      category: 'internal',
      code: 'component-start-failed',
      detail: { component: failed.name },
      cause: error,
    });
  }

  return {
    get state() {
      return state;
    },

    async start(): Promise<void> {
      if (state !== 'created') {
        throw new AppError(`cannot start from the "${state}" state`, {
          category: 'internal',
          code: 'lifecycle-state',
          detail: { state },
        });
      }
      state = 'starting';

      for (const component of components) {
        const startedAt = clock.monotonic();
        try {
          await component.start();
        } catch (error) {
          return rollback(component, error);
        }
        started.push(component);
        log.debug('component started', {
          component: component.name,
          ms: Math.round(clock.monotonic() - startedAt),
        });
      }

      state = 'running';
      log.info('all components started', { components: components.map((c) => c.name) });
    },

    stop(reason: string): Promise<StopReport> {
      // Idempotent by construction: shutdown is reached from a signal handler,
      // and two signals arriving close together must not run the sequence twice.
      if (stopReport) return stopReport;

      state = 'stopping';
      const beganAt = clock.monotonic();
      log.info('stopping', { reason, components: [...started].reverse().map((c) => c.name) });

      stopReport = (async (): Promise<StopReport> => {
        const outcomes: ComponentOutcome[] = [];
        const order = [...started].reverse();

        // Set once the budget is gone, so that the decision is made once rather
        // than recomputed. An earlier version compared the remaining budget
        // afresh on each component, which left a race: a component timing out
        // consumed the budget, but `remaining` could still come back a fraction
        // above zero and the next component would be stopped after all. That
        // showed up as a test failing about one run in ten, which is the
        // failure mode worth removing rather than loosening the assertion for.
        let exhausted = false;

        for (const [index, component] of order.entries()) {
          const remaining = options.stopTimeoutMs - (clock.monotonic() - beganAt);
          if (exhausted || remaining <= 0) {
            // Everything from here on is left alone on purpose. See the note at
            // the top: closing a resource underneath a component that is still
            // running is worse than leaving it to the next start's recovery.
            for (const missed of order.slice(index)) {
              outcomes.push({ name: missed.name, outcome: 'not-reached' });
            }
            break;
          }

          const startedAt = clock.monotonic();
          try {
            const finished = await within(Promise.resolve(component.stop()), remaining);
            const ms = Math.round(clock.monotonic() - startedAt);
            if (finished === null) {
              // A timeout means the budget is gone by definition: the timer
              // fired because the whole remaining allowance elapsed.
              exhausted = true;
              outcomes.push({ name: component.name, outcome: 'timed-out', ms });
              log.error('a component did not stop within the remaining budget', {
                component: component.name,
                ms,
              });
            } else {
              outcomes.push({ name: component.name, outcome: 'stopped', ms });
            }
          } catch (error) {
            outcomes.push({
              name: component.name,
              outcome: 'failed',
              error,
              ms: Math.round(clock.monotonic() - startedAt),
            });
            log.error('a component failed to stop', {
              component: component.name,
              error: String(error),
            });
          }
        }

        started.length = 0;
        state = 'stopped';

        const clean = outcomes.every((outcome) => outcome.outcome === 'stopped');
        const ms = Math.round(clock.monotonic() - beganAt);
        const report: StopReport = { reason, clean, ms, components: outcomes };

        if (clean) log.info('stopped cleanly', { reason, ms });
        else log.warn('stopped, but not cleanly', { reason, ms, outcomes: outcomes.length });

        return report;
      })();

      return stopReport;
    },

    async health(): Promise<HealthReport> {
      const results = await Promise.all(
        started.map(async (component) => {
          if (!component.health) {
            return {
              name: component.name,
              health: { status: 'ok' as const, detail: 'reports no health of its own' },
            };
          }
          try {
            return { name: component.name, health: await component.health() };
          } catch (error) {
            return {
              name: component.name,
              health: { status: 'failing' as const, detail: String(error) },
            };
          }
        }),
      );

      const status = results.reduce<HealthStatus>(
        (worst, entry) => (WORST[entry.health.status] > WORST[worst] ? entry.health.status : worst),
        'ok',
      );

      return { status, components: results };
    },
  };
}
