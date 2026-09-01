#!/usr/bin/env node
/**
 * The executable, and the earliest point in this program's life that code of
 * ours can run.
 *
 * It does as little as possible, because everything it does is untestable
 * without spawning a process. Two things earn their place here anyway, and both
 * are about a window that nothing further in cannot reach.
 *
 * ## Signal handlers come before the imports, and that is the point
 *
 * Loading this daemon's module graph was measured at **325 ms** — mostly the
 * native SQLite driver and what depends on it. Until a handler exists, the
 * default disposition for `SIGTERM`, `SIGINT` and `SIGHUP` is to end the process
 * immediately, so for that third of a second the daemon could be killed outright:
 * no drain, no clean stop, `stoppedAt` left null. A `systemctl restart` in quick
 * succession is enough to hit it.
 *
 * Installing the real handlers earlier does not help, because ECMAScript
 * evaluates every static import before the first statement of the module body.
 * So the placeholders below go up first, `main.ts` is pulled in dynamically
 * afterwards, and anything that arrived in between is handed over rather than
 * lost. The remaining window is Node's own bootstrap, which no program can close.
 *
 * `./exit.ts` is imported statically on purpose: it is a handful of constants
 * with no dependencies, and the error handlers below need it.
 */

import { EXIT } from './exit.ts';
import type { StopSignal } from './signals.ts';

const arrived: StopSignal[] = [];
const placeholders = new Map<StopSignal, () => void>();

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  const handler = () => {
    arrived.push(signal);
  };
  placeholders.set(signal, handler);
  process.on(signal, handler);
}

const release = () => {
  for (const [signal, handler] of placeholders) process.off(signal, handler);
  placeholders.clear();
};

const { runDaemon } = await import('./main.ts');

/**
 * There is nowhere else for an error at this level to go, and a daemon that dies
 * silently on an unhandled rejection is one whose operator learns nothing from
 * the journal.
 */
const fail = (kind: string) => (error: unknown) => {
  process.stderr.write(`${kind}: ${String(error)}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exit(EXIT.INTERNAL);
};

process.on('uncaughtException', fail('uncaught exception'));
process.on('unhandledRejection', fail('unhandled rejection'));

// No process.exit(): setting the code and letting the loop drain is what keeps
// the last lines of the log from being discarded. See main.ts.
process.exitCode = await runDaemon({ early: { arrived, release } });
