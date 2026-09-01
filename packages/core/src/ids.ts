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
 * **Identifiers minted in the same millisecond are ordered too**, by the counter
 * RFC 9562 §6.2 describes. That was not always true here: the first version said
 * the case did not arise often enough to justify the state, and named the trigger
 * for changing it — "if bursts of same-millisecond writes ever need a stable
 * order". M2's audit is that burst. Three turns recorded against a fake adapter
 * landed in one millisecond and came back out of order, and an audit whose
 * identifier is meant to be the cursor for "what happened since" cannot be
 * ordered by something with ties.
 *
 * The counter occupies `rand_a`, the twelve bits after the version nibble, so the
 * format is unchanged and a v7 identifier from before still parses. Within a
 * millisecond it increments; on a new millisecond it is re-seeded randomly with
 * headroom left to climb. It is per process, which is what a single writer needs
 * and all it claims.
 */
/**
 * The last millisecond a value was minted for, and the 74 random bits used then.
 *
 * RFC 9562 §6.2 offers two ways to order identifiers inside one millisecond. The
 * first — a small dedicated counter in `rand_a` — was tried here and is worse
 * than it looks: twelve bits run out after a few thousand, and once the counter
 * saturates the remaining 62 random bits decide the comparison, so ordering does
 * not degrade to ties but to **inversions**. Measured at 2,000 identifiers in one
 * millisecond: 335 of them came out before the one they followed.
 *
 * The second method increments the whole random field instead, which is what
 * these two hold. The headroom is 2^74 rather than 2^12, and the step is random
 * so the sequence is not a predictable count of how many identifiers were minted.
 */
let lastMillis = -1;
let lastRandom = 0n;

const RAND_BITS = 74n;
const RAND_MASK = (1n << RAND_BITS) - 1n;
/** Seeded into the lower half, so there is a whole bit of headroom to climb into. */
const SEED_MASK = RAND_MASK >> 1n;
const RAND_B_MASK = (1n << 62n) - 1n;

function randomBits(bits: number): bigint {
  const bytes = new Uint8Array(Math.ceil(bits / 8));
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value & ((1n << BigInt(bits)) - 1n);
}

/**
 * The random field for this identifier: fresh on a new millisecond, and strictly
 * greater than the last one within the same millisecond.
 *
 * A caller passing an older timestamp than the previous call — a test minting at
 * a fixed past instant — gets a fresh sequence rather than one continued from
 * somewhere else, which is why the comparison is inequality rather than "later".
 */
function nextRandom(millis: number): bigint {
  if (millis !== lastMillis) {
    lastMillis = millis;
    lastRandom = randomBits(74) & SEED_MASK;
    return lastRandom;
  }

  // A random step rather than one, so the value is not a readable count of how
  // many identifiers this process has minted this millisecond. Reaching the top
  // would take 2^58 of them.
  lastRandom = (lastRandom + 1n + randomBits(16)) & RAND_MASK;
  return lastRandom;
}

const HEX = '0123456789abcdef';

export function uuidV7(now: number = Date.now()): Uuid {
  const millis = Math.floor(now);
  const random = nextRandom(millis);

  // 48 bits of timestamp, the version nibble, 12 bits of rand_a, the two variant
  // bits, and 62 bits of rand_b — 128 in total. Assembled as one integer because
  // the alternative is eight byte-level maskings, each of which is a chance to
  // put a bit one place out.
  const value =
    (BigInt(millis) << 80n) |
    (7n << 76n) |
    ((random >> 62n) << 64n) |
    (0b10n << 62n) |
    (random & RAND_B_MASK);

  let hex = '';
  for (let shift = 124n; shift >= 0n; shift -= 4n) {
    hex += HEX[Number((value >> shift) & 0xfn)];
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
