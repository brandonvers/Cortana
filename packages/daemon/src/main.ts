/**
 * The process, and the only place in this codebase that knows there is one.
 *
 * Everything below it is a library: the kernel supervises components, the writer
 * serialises writes, the bus notifies. None of them install a signal handler,
 * read `process.env` on their own, or decide when to exit. That is what makes
 * them testable, and it is why this file is the last one written and the
 * thinnest.
 *
 * ## Why it sets `process.exitCode` instead of calling `process.exit()`
 *
 * `process.exit()` ends the process at once, and anything still buffered on
 * standard output is discarded. For a daemon whose entire log goes to stdout for
 * the journal to collect, that means losing exactly the lines explaining why it
 * stopped — the ones somebody will go looking for. Setting `exitCode` and
 * returning lets the loop drain first.
 *
 * The one exception is an operator signalling twice, which is a request not to
 * wait, and is honoured immediately.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@cortana/config';
import { isAppError, type Logger } from '@cortana/core';
import { createLogger, type RunningKernel, startKernel } from '@cortana/kernel';
import { EXIT, type ExitCode } from './exit.ts';
import { watchForStop } from './signals.ts';

export interface DaemonOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly version?: string;
  /** For tests: an emitter standing in for the process's signals. */
  readonly signalSource?: NodeJS.EventEmitter;
  readonly destination?: NodeJS.WritableStream;
}

function readVersion(): string {
  try {
    const manifest = readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8');
    return (JSON.parse(manifest) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Reports a configuration problem the way an operator needs it.
 *
 * No stack trace: the frames describe this file, and the reader's problem is a
 * line in their own file. The definition of done says "exits naming the setting
 * that is missing — never a stack trace", and this is that sentence in code.
 */
function reportStartupFailure(error: unknown, destination: NodeJS.WritableStream): ExitCode {
  if (isAppError(error) && error.category === 'config') {
    destination.write(`${error.message}\n`);
    return EXIT.CONFIGURATION;
  }
  if (
    isAppError(error) &&
    (error.category === 'storage' || error.code === 'component-start-failed')
  ) {
    destination.write(`${error.message}\n`);
    if (error.cause instanceof Error) destination.write(`  caused by: ${error.cause.message}\n`);
    return EXIT.START_FAILED;
  }
  destination.write(`${String(error)}\n`);
  if (error instanceof Error && error.stack) destination.write(`${error.stack}\n`);
  return EXIT.INTERNAL;
}

export async function runDaemon(options: DaemonOptions = {}): Promise<ExitCode> {
  const env = options.env ?? process.env;
  const version = options.version ?? readVersion();
  const errors = options.destination ?? process.stderr;

  let logger: Logger;
  let kernel: RunningKernel;
  try {
    const loaded = loadConfig(env);
    logger = createLogger({
      level: loaded.config.log.level,
      base: { version },
      ...(options.destination ? { destination: options.destination } : {}),
    });
    logger.info('configuration loaded', {
      file: loaded.file ?? '(defaults only)',
      dataDir: loaded.config.dataDir,
    });
    kernel = await startKernel({ config: loaded.config, logger, version });
  } catch (error) {
    return reportStartupFailure(error, errors);
  }

  const watch = watchForStop({
    logger,
    onInsist: () => {
      // Deliberately immediate. Someone signalling twice has said they would
      // rather have the process gone than have it finish tidying up, and
      // ADR-0017 makes that safe: everything acknowledged is already durable.
      process.exit(EXIT.INSISTED);
    },
    ...(options.signalSource ? { process: options.signalSource } : {}),
  });

  try {
    const { reason } = await watch.requested;
    const report = await kernel.stop(reason);
    if (report.clean) {
      logger.info('stopped', { reason, ms: report.ms });
      return EXIT.OK;
    }
    logger.error('stopped, but not cleanly', {
      reason,
      ms: report.ms,
      components: report.components.filter((c) => c.outcome !== 'stopped').map((c) => c.name),
    });
    return EXIT.UNCLEAN_STOP;
  } catch (error) {
    logger.fatal('the stop sequence itself failed', { error: String(error) });
    return EXIT.INTERNAL;
  } finally {
    watch.dispose();
  }
}
