/**
 * The pino-backed logger, and an honest account of what its redaction reaches.
 *
 * ADR-0018 asks for the secret protection to hold twice, and this is the second
 * layer. It is worth being precise about which layer is load-bearing, because
 * the intuitive answer is wrong and it was measured rather than assumed.
 *
 * ## Layer one is the `Secret` type, and it is the one that holds
 *
 * A `Secret` serialises as `[redacted]`, so pino writes the redaction at any
 * depth, in any field, whatever the field is called. Measured on pino 10.3.1:
 * a `Secret` three levels down came out redacted with no configuration at all.
 *
 * ## Layer two is field-name redaction, and it is depth-bounded
 *
 * `fast-redact`, which pino uses, matches exactly one level per `*`:
 *
 *   paths                          depth 1   depth 2   depth 3   depth 4
 *   password                       redacted  LEAKS
 *   password, *.password           redacted  redacted  LEAKS
 *   password, *.password, *.*.…    redacted  redacted  redacted  LEAKS
 *
 * And the obvious fix does not work. **`**.password` is accepted without error
 * and redacts nothing** — a silent no-op that looks exactly like protection.
 * There is a test below holding that in place, so that nobody later "improves"
 * this configuration into doing less.
 *
 * So the paths here are enumerated to three levels, which covers the shape this
 * system's log fields actually have, and the guidance that follows is not
 * "name the field carefully" but **put credentials in a `Secret`**. Field-name
 * redaction is a backstop for a raw string somebody passed by mistake, not the
 * mechanism.
 *
 * ## Neither layer covers free text, and nothing can
 *
 * `log.info(`connecting as ${password}`)` writes the password. A `Secret`
 * interpolated into a template produces `[redacted]` because the type closes
 * that route, but `secret.expose()` interpolated into one does not, and no
 * logger configuration can tell the difference. That is why `expose()` is a
 * single greppable token, and why there is a test below that demonstrates the
 * leak rather than leaving the boundary to be discovered.
 */

import type { LogLevel } from '@cortana/config';
import type { LogFields, Logger } from '@cortana/core';
import { pino } from 'pino';

export const REDACTION = '[redacted]';

/**
 * Field names whose values are never worth writing down.
 *
 * Broad enough to catch the usual spellings, narrow enough not to redact
 * something legitimate: `key` is deliberately absent, because a field called
 * `key` is far more often a map key or a settings key than a credential, and a
 * log that redacts ordinary values teaches people to stop reading it.
 */
const SENSITIVE = [
  'password',
  'passwd',
  'secret',
  'clientSecret',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'sessionToken',
  'apiKey',
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'cookie',
  'credentials',
  'privateKey',
] as const;

/** The same names at the top level and at two levels of nesting. See above. */
export const REDACT_PATHS: readonly string[] = SENSITIVE.flatMap((name) => [
  name,
  `*.${name}`,
  `*.*.${name}`,
]);

export interface LoggerOptions {
  readonly level: LogLevel;
  /**
   * Where entries go. Defaults to standard output, which is what a systemd unit
   * wants: the journal captures it, so a service needs no file configuration and
   * no log rotation of its own.
   */
  readonly destination?: NodeJS.WritableStream;
  /** Fields added to every entry. */
  readonly base?: LogFields;
}

type PinoLogger = ReturnType<typeof pino>;

/** Adapts pino's `(fields, message)` to this project's `(message, fields)`. */
function adapt(instance: PinoLogger): Logger {
  return {
    trace: (message, fields) => instance.trace(fields ?? {}, message),
    debug: (message, fields) => instance.debug(fields ?? {}, message),
    info: (message, fields) => instance.info(fields ?? {}, message),
    warn: (message, fields) => instance.warn(fields ?? {}, message),
    error: (message, fields) => instance.error(fields ?? {}, message),
    fatal: (message, fields) => instance.fatal(fields ?? {}, message),
    child: (fields) => adapt(instance.child(fields)),
  };
}

export function createLogger(options: LoggerOptions): Logger {
  return adapt(
    pino(
      {
        level: options.level,
        base: { ...options.base },
        redact: { paths: [...REDACT_PATHS], censor: REDACTION },
      },
      options.destination ?? process.stdout,
    ),
  );
}
