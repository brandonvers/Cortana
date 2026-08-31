/**
 * What a valid configuration looks like, and nothing more.
 *
 * Two rules govern what appears here.
 *
 * **A setting exists because something reads it.** M1 has three. Settings for
 * milestones that have not been built would be guesses that later have to be
 * either honoured or broken.
 *
 * **Not everything configurable should be configured.** ADR-0017 makes SQLite's
 * `synchronous` setting deliberately absent: a durability guarantee that a
 * configuration file can switch off is not a guarantee, and the failure it
 * produces — a lost transaction after a power cut, months later — is untraceable
 * to the setting that caused it.
 */

import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { Secret } from './secret.ts';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The object is strict: an unrecognised key is an error rather than something
 * ignored. A misspelled setting that silently does nothing is the worst outcome
 * available, because the system starts, looks configured, and behaves as though
 * the line had never been written.
 */
export const configSchema = z.strictObject({
  /**
   * Where the database and everything else durable lives. Must be absolute — a
   * relative path resolves against the working directory, which for a service is
   * `/` and is not what anybody means.
   */
  dataDir: z.string().min(1).refine(isAbsolute, { error: 'must be an absolute path' }),

  log: z.strictObject({
    level: z.enum(LOG_LEVELS),
  }),

  shutdown: z.strictObject({
    /**
     * How long draining may take before the process stops waiting.
     *
     * The upper bound exists because a larger value cannot be honoured: systemd
     * sends `SIGKILL` after `TimeoutStopSec`, so a deadline beyond that is a
     * promise the process is in no position to keep.
     */
    timeoutMs: z.int().positive().max(600_000),
  }),
});

export type Config = z.infer<typeof configSchema>;

/**
 * A setting whose value is a credential.
 *
 * Nothing in M1 uses it yet. ADR-0018 requires the mechanism to exist before the
 * first credential does, so that the first module needing one does not invent
 * its own handling under deadline.
 *
 * Validation deliberately checks nothing but presence. Zod does not echo values
 * in its messages, and a test in this package holds it to that — but the way to
 * be certain a secret never appears in a validation error is to never give a
 * validator a reason to describe it.
 */
export const secretSchema = z
  .string()
  .min(1)
  .transform((value) => new Secret(value));
