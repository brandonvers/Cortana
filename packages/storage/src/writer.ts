/**
 * One serialised writer, and a contract that makes serialising it worth anything.
 *
 * ADR-0010 and ADR-0011 both say every write goes through a single writer queue
 * in the kernel. It is worth being precise about what that buys, because with a
 * synchronous driver the obvious reading is wrong: `better-sqlite3` statements
 * cannot interleave with each other, so serialising *statements* protects
 * nothing that was not already safe.
 *
 * What can interleave is a **logical unit of work that spans an `await`**.
 * Measured, on three concurrent callers doing a read-modify-write against one
 * row with no gate at all:
 *
 *   read, await, write   ->  final value 1   (two updates lost)
 *   the same work, sync  ->  final value 3   (correct)
 *
 * So what has to be serialised is the *unit*, and what makes that possible is
 * that **the unit is synchronous**. That is ADR-0010's "its synchronous API is a
 * feature, not a compromise", enforced rather than remembered: work returning a
 * promise is rolled back and reported, because by the time a promise resolves the
 * transaction around it has already committed.
 *
 * ## What the queue is and is not doing, stated honestly
 *
 * The queue is **not** what prevents the lost updates above. That was established
 * by breaking this file on purpose: with the queueing removed and every unit run
 * inline, twenty concurrent read-modify-writes still produced twenty increments.
 * The synchronous contract is what makes them safe; a mutex would add nothing,
 * and neither does the queue, for in-process callers as they exist today.
 *
 * What the queue does carry:
 *
 * - **A shutdown gate.** One place that stops accepting work and reports when
 *   what it accepted has finished. Step 5 needs this and nothing else provides it.
 * - **A transaction around every write**, so "durable before acknowledged" is
 *   structural rather than something each caller has to remember.
 * - **A refusal to nest.** A write started inside another would commit
 *   separately while looking atomic, so it is rejected rather than allowed.
 * - **Somewhere for writes that arrive from outside this call stack to land.**
 *   ADR-0013 anticipates them: a module with `isolation: 'process'` cannot use
 *   the native driver, so "every database access would have to be marshalled
 *   through the kernel". That path is asynchronous by construction, and it is the
 *   one that will genuinely need ordering rather than merely having it.
 *
 * Stated this plainly on purpose. A component named "writer queue" invites the
 * assumption that it is what makes concurrent writing safe, and someone relying
 * on that would be relying on the wrong thing.
 *
 * Reads are not gated. ADR-0010: reads run freely.
 */

import { AppError, type Clock, systemClock } from '@cortana/core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Storage } from './open.ts';
import type * as schema from './schema.ts';

export interface WriteContext {
  /** The typed query layer, inside the transaction. */
  readonly db: BetterSQLite3Database<typeof schema>;
  /** The driver, for the hand-written SQL ADR-0010 expects. */
  readonly connection: Storage['connection'];
}

export interface WriteStats {
  readonly enqueued: number;
  readonly completed: number;
  readonly failed: number;
  /** The most work ever waiting at once. Zero pressure reads as 1. */
  readonly maxDepth: number;
  /** Total time spent inside write units, in milliseconds. */
  readonly busyMs: number;
}

export interface Writer {
  /**
   * Runs `work` with exclusive access to the database, inside a transaction.
   *
   * `work` must be synchronous. Returning a promise from it is a defect rather
   * than a style choice — see the note at the top of this file — and is reported
   * as one, with the transaction rolled back.
   */
  write<T>(label: string, work: (context: WriteContext) => T): Promise<T>;
  /** Units waiting, including the one executing. */
  readonly depth: number;
  readonly stats: WriteStats;
  readonly draining: boolean;
  /**
   * Stops accepting work and resolves once what was accepted has finished.
   *
   * Deliberately unbounded: the deadline belongs to whoever is shutting the
   * process down, because only they know how long they have.
   */
  drain(): Promise<void>;
}

interface Task {
  readonly label: string;
  readonly run: (context: WriteContext) => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export interface WriterOptions {
  readonly storage: Storage;
  readonly clock?: Clock;
}

export function createWriter(options: WriterOptions): Writer {
  const { storage } = options;
  const clock = options.clock ?? systemClock;
  const context: WriteContext = { db: storage.db, connection: storage.connection };

  // Created once rather than per call, which is what better-sqlite3 asks for.
  // The thunk is the unit of work; the transaction is what surrounds it.
  const inTransaction = storage.connection.transaction((run: () => unknown) => run());

  const pending: Task[] = [];
  let executing = false;
  let pumping = false;
  let scheduled = false;
  let draining = false;
  let drained: (() => void)[] = [];

  let enqueued = 0;
  let completed = 0;
  let failed = 0;
  let maxDepth = 0;
  let busyMs = 0;

  const depth = () => pending.length + (executing ? 1 : 0);

  function settleDrain(): void {
    if (!draining || depth() > 0) return;
    const waiters = drained;
    drained = [];
    for (const waiter of waiters) waiter();
  }

  function pump(): void {
    if (pumping) return;
    pumping = true;

    while (pending.length > 0) {
      const task = pending.shift() as Task;
      executing = true;
      const startedAt = clock.monotonic();
      try {
        const value = inTransaction(() => {
          const result = task.run(context);
          if (isThenable(result)) {
            // Thrown from inside the transaction so it rolls back. A promise
            // here means the caller's work is still running while the commit
            // has already happened, which is the one failure the synchronous
            // contract exists to prevent.
            throw new AppError(
              `the write unit "${task.label}" returned a promise. Write units must be ` +
                'synchronous: the transaction around one commits when it returns, so ' +
                'anything awaited inside it would run after the commit.',
              {
                category: 'internal',
                code: 'asynchronous-write-unit',
                detail: { label: task.label },
              },
            );
          }
          return result;
        });
        completed += 1;
        busyMs += clock.monotonic() - startedAt;
        executing = false;
        task.resolve(value);
      } catch (error) {
        failed += 1;
        busyMs += clock.monotonic() - startedAt;
        executing = false;
        // One unit failing rolls back that unit and nothing else. The queue
        // keeps going, because the next caller's work is unrelated to it.
        task.reject(error);
      }
    }

    pumping = false;
    settleDrain();
  }

  return {
    write<T>(label: string, work: (context: WriteContext) => T): Promise<T> {
      if (executing) {
        // Enqueuing here would run the inner unit outside the caller's
        // transaction, which is worse than refusing: the caller would believe
        // the two were atomic together.
        return Promise.reject(
          new AppError(
            `the write unit "${label}" was started from inside another write unit. ` +
              'Compose the work into one unit rather than nesting, so that all of it ' +
              'commits or none of it does.',
            { category: 'internal', code: 'nested-write-unit', detail: { label } },
          ),
        );
      }

      if (draining) {
        return Promise.reject(
          new AppError(`the writer is shutting down and refused the write unit "${label}"`, {
            category: 'storage',
            code: 'writer-draining',
            detail: { label },
          }),
        );
      }

      return new Promise<T>((resolve, reject) => {
        pending.push({
          label,
          run: work as (context: WriteContext) => unknown,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        enqueued += 1;
        maxDepth = Math.max(maxDepth, depth());
        // Deferred rather than run inline, so that ordering is the same whether
        // one caller or twenty are writing, and so that the queue is a real
        // queue for the marshalled writes ADR-0013 anticipates.
        //
        // Scheduled at most once per drain cycle. Twenty callers enqueuing in
        // one tick would otherwise schedule twenty pumps, nineteen of which
        // find an empty queue. Nothing is missed by the guard: a task added
        // after the pump is scheduled but before it runs is picked up by the
        // same pass, because the pump loops until the queue is empty.
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(() => {
            scheduled = false;
            pump();
          });
        }
      });
    },

    get depth() {
      return depth();
    },

    get stats(): WriteStats {
      return { enqueued, completed, failed, maxDepth, busyMs };
    },

    get draining() {
      return draining;
    },

    drain(): Promise<void> {
      draining = true;
      if (depth() === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        drained.push(resolve);
      });
    },
  };
}
