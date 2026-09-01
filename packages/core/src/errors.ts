/**
 * One error type, categorised, so that the process can tell an operator's
 * mistake from its own.
 *
 * The distinction this exists to draw is not cosmetic. A daemon that cannot
 * start because a setting is missing should print the setting and exit; a daemon
 * that cannot start because of a defect in this code should say so loudly and
 * leave a stack trace, because somebody has to fix it. Both arrive at the same
 * top-level handler as an `Error`, and without a category that handler has to
 * guess — usually by matching on message text, which then breaks when the
 * message is reworded.
 *
 * The class is deliberately **not** named after the product.
 * `docs/adr/0002-project-name.md` requires that renaming stays cheap, and a type
 * imported by every package in the tree is exactly the kind of thing that makes
 * it expensive.
 */

/**
 * What kind of thing went wrong, which is really the question "whose problem is
 * this and what should happen next".
 *
 * The list is short on purpose: a category is added when something needs to
 * behave differently because of it, not in anticipation. `unavailable` and
 * `conflict` are the obvious next two and neither has a caller yet.
 */
export type ErrorCategory =
  /** The operator's configuration is wrong or incomplete. Fix it and restart. */
  | 'config'
  /** A value crossing a boundary failed validation. Never coerce; surface it. */
  | 'contract'
  /** The database refused, failed, or is in a state this code will not touch. */
  | 'storage'
  /** A bounded wait ran out. Says nothing about whether the work succeeded. */
  | 'timeout'
  /**
   * The model provider refused, failed, or answered in a way the port cannot
   * use. Not the operator's fault and not necessarily ours: the provider is a
   * system nobody here controls, which is the whole reason ADR-0001 puts a port
   * in front of it.
   */
  | 'provider'
  /** A defect in this code. Not the operator's fault and not recoverable here. */
  | 'internal';

/**
 * Structured context attached to an error, for the log line and the audit record.
 *
 * The value type is deliberately narrow. Anything that can hold arbitrary
 * objects ends up holding a whole request, and a whole request eventually holds
 * a credential — so this carries scalars, and a credential is not a scalar this
 * type will accept once `Secret` exists.
 */
export type ErrorDetail = Readonly<Record<string, string | number | boolean>>;

export interface AppErrorOptions {
  readonly category: ErrorCategory;
  /**
   * A stable, machine-readable identifier for this specific failure, in
   * lower-kebab-case: `missing-setting`, `migration-ahead-of-binary`.
   *
   * Messages get reworded and translated; codes are what a log query, an alert,
   * or a runbook can be written against, so they are treated as an interface and
   * changed with the same care.
   */
  readonly code: string;
  readonly detail?: ErrorDetail;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly detail: ErrorDetail;

  constructor(message: string, options: AppErrorOptions) {
    super(message, { cause: options.cause });
    // `Error` sets `name` to the constructor's name only for the base class, so
    // subclasses that do not set it report as "Error" in logs and stack traces.
    this.name = new.target.name;
    this.category = options.category;
    this.code = options.code;
    this.detail = options.detail ?? {};
  }
}

/** Whether a value is one of this system's errors rather than an arbitrary throw. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Whether an error means *this code* is wrong.
 *
 * Anything that is not one of ours counts, and that is the point rather than an
 * oversight: a `TypeError` escaping to the top level is a defect exactly as much
 * as an explicit `internal` is, and treating "unrecognised" as "probably fine"
 * is how a bug becomes a log line nobody reads.
 */
export function isBug(value: unknown): boolean {
  return !isAppError(value) || value.category === 'internal';
}
