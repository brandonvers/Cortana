/**
 * Logging, as a port.
 *
 * It is here rather than in the kernel for the same reason the clock is: this
 * package has no dependencies, which is what lets every other package and every
 * third-party module depend on it. A logging *implementation* needs one — the
 * kernel provides a pino-backed logger — but a `storage` or a `config` that
 * wants to say something should not have to import the kernel to say it.
 *
 * The argument order is `(message, fields)`, which is the reverse of pino's. A
 * call reads as a sentence that way, and the adapter that flips it lives in one
 * place instead of at every call site.
 */

/**
 * Structured context attached to a log entry.
 *
 * `unknown` rather than a narrow union on purpose: this is where a
 * `Secret` belongs. Its JSON form is a redaction, so a credential passed here
 * cannot reach the output — which is the layer that actually holds, and the
 * reason the guidance is to pass secrets rather than to trust field names.
 */
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  fatal(message: string, fields?: LogFields): void;
  /** A logger that adds these fields to everything it writes. */
  child(fields: LogFields): Logger;
}

/** The levels, in increasing severity, as the port names them. */
export const LOG_METHODS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogMethod = (typeof LOG_METHODS)[number];
