/**
 * Turning a signal into a request to stop, and a second one into an answer of
 * "yes, now".
 *
 * The default disposition for `SIGTERM` and `SIGINT` is to end the process
 * immediately. Installing a handler replaces that, which is the point — a
 * graceful stop needs the process to survive long enough to perform one — and it
 * also creates the obligation to still stop when someone insists. An operator
 * pressing Ctrl-C twice has said something clear, and a daemon that keeps
 * politely draining after that is a daemon people learn to `kill -9`.
 *
 * ## A signal listener does not keep the process running
 *
 * This is the part that is not obvious, and it was found by running the daemon
 * rather than by reading about it. Measured on Node 24:
 *
 *   process.on('SIGTERM', …); await new Promise(() => {})
 *     -> exits on its own, code 13, "Detected unsettled top-level await"
 *
 *   the same, plus one ref'd timer
 *     -> stays running
 *
 * A signal listener is not something libuv counts as a reason to stay alive. A
 * daemon whose whole job is to sit still and wait therefore has an empty event
 * loop, and Node ends it — after starting the database, recording the run, and
 * announcing itself, so the failure looks like a crash rather than like a
 * missing handle.
 *
 * The wait is held open here rather than in the caller, because whoever owns the
 * waiting owns the obligation to still be there when the signal arrives.
 */

import type { Logger } from '@cortana/core';

export type StopSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP';

export interface StopRequest {
  readonly reason: string;
}

export interface SignalWatch {
  /** Resolves when a stop is first requested. */
  readonly requested: Promise<StopRequest>;
  /** Removes the handlers, restoring the default disposition. */
  dispose(): void;
}

/**
 * Signals that arrived before this module was even loaded, collected by the
 * placeholder handlers in `bin.ts`. See the note there: the module graph takes
 * long enough to load that the window is real.
 */
export interface EarlySignals {
  readonly arrived: readonly StopSignal[];
  /** Removes the placeholders, once the real handlers are in place. */
  release(): void;
}

export interface SignalOptions {
  readonly logger: Logger;
  readonly early?: EarlySignals;
  /**
   * What to do when a second signal arrives while the first is being honoured.
   * Separated so a test can observe it without ending the test runner.
   */
  readonly onInsist: (signal: StopSignal) => void;
  readonly process?: NodeJS.EventEmitter;
}

/**
 * How often the keep-alive fires. Long enough to be free, short enough that it
 * is a timer rather than a deadline: it never expires, it re-arms.
 */
const KEEP_ALIVE_MS = 60_000;

export function watchForStop(options: SignalOptions): SignalWatch {
  const emitter = options.process ?? process;
  const log = options.logger.child({ component: 'signals' });

  let announce: (request: StopRequest) => void = () => undefined;
  const requested = new Promise<StopRequest>((resolve) => {
    announce = resolve;
  });

  let already = false;
  const handlers = new Map<StopSignal, () => void>();

  const attach = (signal: StopSignal) => {
    const handler = () => {
      if (already) {
        log.warn('a second signal arrived while stopping; giving up on a clean stop', { signal });
        options.onInsist(signal);
        return;
      }
      already = true;
      log.info('stop requested', { signal });
      announce({ reason: signal });
    };
    handlers.set(signal, handler);
    emitter.on(signal, handler);
  };

  attach('SIGTERM');
  attach('SIGINT');

  // The reason this exists is at the top of the file. It is cleared by dispose(),
  // so nothing is left holding the loop open once the wait is over.
  const keepAlive = setInterval(() => undefined, KEEP_ALIVE_MS);

  // SIGHUP's default disposition also ends the process, and it is conventionally
  // a request to reload configuration rather than to stop. There is no reload
  // yet, so it is caught and answered honestly instead of quietly killing a
  // daemon whose operator expected a reload.
  const hangup = () => {
    log.warn('SIGHUP received; reloading configuration is not implemented, so nothing changed');
  };
  handlers.set('SIGHUP', hangup);
  emitter.on('SIGHUP', hangup);

  // Real handlers are in place, so the placeholders can go. Released before the
  // backlog is read, not after: a signal landing in between hits a real handler
  // rather than falling into a gap.
  options.early?.release();

  for (const signal of options.early?.arrived ?? []) {
    if (signal === 'SIGHUP') {
      hangup();
      continue;
    }
    if (already) continue;
    already = true;
    log.info('stop requested before the daemon had finished starting', { signal });
    announce({ reason: signal });
  }

  return {
    requested,
    dispose() {
      clearInterval(keepAlive);
      for (const [signal, handler] of handlers) emitter.off(signal, handler);
      handlers.clear();
    },
  };
}
