#!/usr/bin/env node
/**
 * The executable.
 *
 * It does as little as possible, because everything it does is untestable
 * without spawning a process. The two handlers below are the exception: they
 * exist precisely because there is nowhere else for an error at this level to
 * go, and a daemon that dies silently on an unhandled rejection is a daemon
 * whose operator learns nothing from the journal.
 */

import { EXIT } from './exit.ts';
import { runDaemon } from './main.ts';

const fail = (kind: string) => (error: unknown) => {
  process.stderr.write(`${kind}: ${String(error)}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exit(EXIT.INTERNAL);
};

process.on('uncaughtException', fail('uncaught exception'));
process.on('unhandledRejection', fail('unhandled rejection'));

// No process.exit(): setting the code and letting the loop drain is what keeps
// the last lines of the log from being discarded. See main.ts.
process.exitCode = await runDaemon();
