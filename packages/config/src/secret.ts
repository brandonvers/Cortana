/**
 * A value that cannot reach a log line by accident.
 *
 * `docs/adr/0018-secrets-at-rest.md` splits the problem in two, and this is the
 * half that matters most in practice. Credentials rarely escape because someone
 * broke the encryption; they escape because a value got interpolated into a
 * message, spread into a structured log, or printed while somebody was
 * debugging. No storage mechanism helps with any of that.
 *
 * So the value lives in a private field — genuinely private, not merely
 * conventional — and every route by which JavaScript turns an object into text
 * is closed:
 *
 * | Route | Closed by |
 * |---|---|
 * | `String(s)`, `` `${s}` ``, `s + ''` | `Symbol.toPrimitive` |
 * | `s.toString()` | `toString` |
 * | `JSON.stringify({ s })` | `toJSON` |
 * | `console.log(s)`, `util.inspect(s)` | the inspect symbol |
 * | `{ ...s }`, `Object.keys(s)` | the field is `#private`, so there is nothing to enumerate |
 *
 * Reading the value takes an explicit `expose()`, which is a single greppable
 * token: `grep -rn 'expose()'` lists every place in the codebase where a
 * credential becomes an ordinary string.
 */

/** What every stringification of a secret produces instead of the value. */
export const REDACTED = '[redacted]';

/**
 * Node's `util.inspect` looks for this well-known registered symbol. It is
 * referenced through `Symbol.for` rather than by importing `node:util`, so this
 * module stays free of Node-specific imports and the behaviour still applies
 * wherever `util.inspect` runs.
 */
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /**
   * The value itself.
   *
   * Every call is a deliberate decision to hold a credential as a plain string,
   * and is meant to be visible in review. Keep the result in as small a scope as
   * possible, and never put it anywhere that gets logged, serialised, or turned
   * into an error message.
   */
  expose(): string {
    return this.#value;
  }

  /** How long the secret is. Lets a validator check shape without seeing it. */
  get length(): number {
    return this.#value.length;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [INSPECT](): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    // Every hint, including 'number'. `+secret` producing NaN is a better
    // outcome than producing a credential.
    return REDACTED;
  }

  static is(value: unknown): value is Secret {
    return value instanceof Secret;
  }
}
