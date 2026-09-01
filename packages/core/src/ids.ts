/**
 * Identifiers that a compiler can tell apart.
 *
 * Every identifier in this system is a string, which means that without help
 * nothing stops an agent's identifier being passed where a job's is expected.
 * The failure is silent, survives every test that uses realistic-looking data,
 * and surfaces as a lookup that returns nothing.
 *
 * A brand is the cheapest fix: a phantom property that exists only in the type
 * system, so the values stay ordinary strings at runtime — no wrapper objects,
 * no serialisation concerns, and nothing to strip before a value reaches SQLite.
 */

declare const brand: unique symbol;

/**
 * A nominal type over a structural one.
 *
 * `Brand<string, 'AgentId'>` is assignable to `string` and `string` is not
 * assignable to it, which is the asymmetry that makes it useful: reading an
 * identifier is free, minting one is deliberate.
 */
export type Brand<T, Name extends string> = T & { readonly [brand]: Name };

/**
 * A UUID as text, in the canonical hyphenated form.
 *
 * Branded so that a function taking a UUID cannot be handed an arbitrary string
 * that merely happens to be a string.
 */
export type Uuid = Brand<string, 'Uuid'>;

/**
 * Identifies one running daemon process.
 *
 * Identifiers appear here in the milestone that first creates one, rather than
 * being invented ahead of a schema. M1 created this; M2 adds the session below.
 */
export type InstanceId = Brand<string, 'InstanceId'>;

/**
 * Identifies one model session.
 *
 * A session is the expensive object in this system — spike 0003 measured 263 MB
 * per idle one — so it has an identity rather than being an anonymous handle:
 * the audit correlates a turn to the session that ran it, and an operator asking
 * "which one cost that" needs the question to have an answer.
 */
export type SessionId = Brand<string, 'SessionId'>;

const HEX = '0123456789abcdef';

/**
 * A version 7 UUID: 48 bits of millisecond timestamp, then randomness.
 *
 * Two questions are worth answering here, because both look like they have
 * easier answers than they do.
 *
 * **Why not `crypto.randomUUID()`?** It produces version 4 — entirely random.
 * These identifiers become primary keys in SQLite, and a v7 value sorts by the
 * moment it was created, which makes the identifier itself a usable cursor for
 * "what happened since" over an audit trail or a queue. A v4 key needs a
 * separate timestamp column and a second index to answer the same question.
 *
 * **Why hand-write it rather than take a dependency?** `CONTRIBUTING.md` warns
 * against hand-rolling what a maintained library solves, and that warning is
 * aimed at cron parsers and retry logic — stateful things with edge cases. This
 * is twenty lines of byte layout from RFC 9562 §5.7, fully covered by tests.
 * More decisively, this package is defined by having **no dependencies at all**,
 * which is what lets every other package and every third-party module depend on
 * it. A dependency here would cost that.
 *
 * **One documented limit:** identifiers minted within the same millisecond have
 * no defined order relative to one another. RFC 9562 §6.2 describes a counter
 * that would fix it; at this system's rate — jobs per minute, not per
 * millisecond — the case does not arise often enough to justify the state. If
 * bursts of same-millisecond writes ever need a stable order, that is the
 * change to make, and it does not alter the format.
 */
export function uuidV7(now: number = Date.now()): Uuid {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Bytes 0-5: the timestamp, big-endian. Division rather than bit shifting,
  // because the value exceeds 32 bits and JavaScript's bitwise operators do not.
  let remaining = Math.floor(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }

  // The version nibble (7) and the two variant bits (0b10), which is what makes
  // this a UUID rather than sixteen arbitrary bytes.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  let hex = '';
  for (const byte of bytes) {
    hex += HEX[byte >> 4];
    hex += HEX[byte & 0x0f];
  }

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as Uuid;
}

/** The millisecond a version 7 UUID was minted, or `null` if it is not one. */
export function timestampOf(id: Uuid): number | null {
  if (id.length !== 36 || id[14] !== '7') return null;
  const hex = `${id.slice(0, 8)}${id.slice(9, 13)}`;
  const ms = Number.parseInt(hex, 16);
  return Number.isNaN(ms) ? null : ms;
}

/** Mints the identifier for one running daemon process. */
export function newInstanceId(now?: number): InstanceId {
  return uuidV7(now) as string as InstanceId;
}

/** Mints the identifier for one model session. */
export function newSessionId(now?: number): SessionId {
  return uuidV7(now) as string as SessionId;
}
