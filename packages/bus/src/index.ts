/**
 * The in-process event bus, typed against a map the publisher and the subscriber
 * both compile against.
 *
 * ADR-0011 declined Redis and everything like it, and the sentence that matters
 * is the one about what replaces it: "the event bus is in-process and typed — no
 * serialisation, no network hop, and a compile-time contract between publisher
 * and subscriber." The compile-time part is the whole point. A bus that takes a
 * string and `unknown` is a bus where a renamed event fails at runtime, in
 * production, in whichever subscriber nobody thought to update.
 *
 * ## Why this is its own package
 *
 * A module that wants to react to an event should not have to import the kernel
 * to get the type of that event. If the event types lived in the kernel, every
 * connector and every pack would depend on it, and the failure boundary
 * ADR-0013 describes would be drawn around something that had already reached
 * inside.
 *
 * ## What is deliberately not here
 *
 * **Durability.** What spike 0005 called "the bus" had two halves, and the
 * durable one — reports that survive a `SIGKILL`, leases, idempotency — is in
 * `@cortana/storage`, because it is a database concern. This half is
 * notification between parts of one process, and it survives nothing. Anything
 * that must outlive a crash goes through the writer, not through here.
 *
 * **A registry that third-party modules extend.** Typing an event across a
 * boundary where the other side is loaded at runtime is a real problem and it
 * belongs to the milestone that builds modules. Guessing at it now would be
 * designing against an imaginary constraint.
 */

import { AppError } from '@cortana/core';

/**
 * A map of event name to the payload that event carries.
 *
 * Constrained to `object` rather than `Record<string, unknown>`, which is the
 * tighter and more descriptive constraint and also the wrong one: TypeScript
 * gives a type alias an implicit index signature and an interface none, so
 * `Record<string, unknown>` rejects `interface MyEvents { ... }` — the way most
 * people will write this. A constraint that refuses the natural spelling is a
 * defect in the constraint.
 */
export type EventMap = object;

export type Handler<Payload> = (payload: Payload) => void | Promise<void>;

/** Stops a handler receiving further events. Calling it twice is harmless. */
export type Unsubscribe = () => void;

export interface HandlerFailure {
  readonly event: string;
  /** Where in the subscription order the failing handler sat. */
  readonly position: number;
  readonly error: unknown;
}

export interface BusStats {
  readonly published: number;
  readonly delivered: number;
  readonly failed: number;
  readonly subscribers: number;
}

export interface Bus<Events extends EventMap> {
  /**
   * Delivers an event to everyone subscribed to it.
   *
   * Handlers are **invoked** in subscription order. An asynchronous handler is
   * not waited for before the next is invoked, so they overlap: subscribers are
   * independent by design, and making one wait for another would let a slow one
   * decide how fast the rest see the world.
   *
   * The returned promise settles when every handler has settled. **It never
   * rejects** — a subscriber's failure is that subscriber's, and letting it
   * reach the publisher would make every publish site responsible for code it
   * does not know about. Failures go to `onHandlerError` instead.
   */
  publish<Name extends keyof Events & string>(event: Name, payload: Events[Name]): Promise<void>;

  subscribe<Name extends keyof Events & string>(
    event: Name,
    handler: Handler<Events[Name]>,
  ): Unsubscribe;

  /** Stops delivery and forgets every subscriber. Publishing afterwards throws. */
  close(): void;

  readonly closed: boolean;
  readonly stats: BusStats;
}

export interface BusOptions {
  /**
   * What to do when a subscriber throws or rejects.
   *
   * Required, with no default, because every available default is wrong in a way
   * that would not be noticed. Swallowing hides a defect; rethrowing takes down
   * a process because something that was only listening had a bug; logging is
   * not possible from a package that depends on nothing. The kernel knows what
   * it wants, and this makes it say so.
   */
  readonly onHandlerError: (failure: HandlerFailure) => void;
}

/**
 * Checked structurally rather than with `instanceof Promise`, which is false for
 * a thenable from another realm or from a library that returns its own.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

interface Subscription {
  readonly handler: Handler<never>;
  active: boolean;
}

export function createBus<Events extends EventMap>(options: BusOptions): Bus<Events> {
  const subscriptions = new Map<string, Subscription[]>();
  let closed = false;
  let published = 0;
  let delivered = 0;
  let failed = 0;

  const countSubscribers = () => {
    let total = 0;
    for (const list of subscriptions.values()) {
      total += list.filter((entry) => entry.active).length;
    }
    return total;
  };

  return {
    subscribe<Name extends keyof Events & string>(
      event: Name,
      handler: Handler<Events[Name]>,
    ): Unsubscribe {
      if (closed) {
        throw new AppError(`the bus is closed and refused a subscription to "${event}"`, {
          category: 'internal',
          code: 'bus-closed',
          detail: { event },
        });
      }

      const entry: Subscription = { handler: handler as Handler<never>, active: true };
      const list = subscriptions.get(event);
      if (list) list.push(entry);
      else subscriptions.set(event, [entry]);

      return () => {
        entry.active = false;
      };
    },

    // Deliberately not an `async` function. Publishing to a closed bus is the
    // caller's mistake, and an async function would report it as a rejected
    // promise — which a fire-and-forget publisher never looks at, so the mistake
    // would surface as an unhandled rejection during shutdown, at the moment
    // there is least attention to spare. Throwing synchronously puts it at the
    // call site instead.
    publish<Name extends keyof Events & string>(event: Name, payload: Events[Name]): Promise<void> {
      if (closed) {
        throw new AppError(`the bus is closed and refused to publish "${event}"`, {
          category: 'internal',
          code: 'bus-closed',
          detail: { event },
        });
      }

      published += 1;

      // A snapshot, so that a handler subscribing during delivery does not
      // receive the event it is reacting to — which is a loop that is very hard
      // to see in a stack trace. `active` is still checked as the list is walked,
      // so a handler unsubscribed by an earlier one does not run: "off means
      // off" (CONCEPTS §5.2) should not have an exception for timing.
      const snapshot = subscriptions.get(event)?.slice() ?? [];
      const settled: Promise<void>[] = [];

      for (const [position, entry] of snapshot.entries()) {
        if (!entry.active) continue;

        const record = (error: unknown) => {
          failed += 1;
          options.onHandlerError({ event, position, error });
        };

        try {
          const result = (entry.handler as Handler<Events[Name]>)(payload);
          if (isThenable(result)) {
            // Counted when it settles, not when it starts: a handler that
            // rejects was not delivered to, and counting it both ways would
            // make the two numbers disagree by exactly the failures.
            settled.push(
              Promise.resolve(result).then(() => {
                delivered += 1;
              }, record),
            );
          } else {
            delivered += 1;
          }
        } catch (error) {
          record(error);
        }
      }

      return Promise.all(settled).then(() => undefined);
    },

    close(): void {
      closed = true;
      subscriptions.clear();
    },

    get closed() {
      return closed;
    },

    get stats(): BusStats {
      return { published, delivered, failed, subscribers: countSubscribers() };
    },
  };
}
