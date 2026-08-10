# 0010. SQLite via better-sqlite3, with Drizzle, sqlite-vec, and two FTS5 indexes

**Status:** Accepted
**Date:** 2026-08-10

## Context

One process, one machine, one user. Every piece of state — the durable queue,
audit events, agent inboxes, memory — has to survive a `SIGKILL`, and the memory
system needs both full-text and vector search over the same records.

Three SQLite drivers were candidates, and the deciding factor was not speed.

The memory system needs a **loadable SQLite extension** for vector search. Apple's
system SQLite build **disables extension loading**, so any driver that uses the
platform's SQLite requires macOS users to install a separate SQLite and point the
driver at it. `better-sqlite3` bundles its own SQLite and does not have this
problem.

The built-in `node:sqlite` module is at release-candidate stability, requires
extensions to be enabled at construction, and **is not supported by the migration
tool** for the chosen query layer.

## Decision

- **`better-sqlite3`** as the driver, WAL mode, with all writes through a single
  serialised writer queue in the kernel. Reads run freely.
- **Drizzle** as the query layer, with raw SQL wherever the query is genuinely
  SQL — full-text and vector queries are hand-written.
- **`sqlite-vec`** for vector search, in the same database and the same
  transaction as everything else.
- **Two FTS5 indexes, not one** — see below.

### Two lexical indexes

FTS5 ships stemmers for a handful of languages. For a language it does not stem,
and for agglutinative languages in particular, a single index **silently** fails
to match inflected forms: the query succeeds and returns nothing, and that empty
result then poisons the rank fusion.

This was measured, not assumed. A diacritic-folding index (`unicode61
remove_diacritics 2`) matches accented text typed without accents, but does not
match a stem against an inflected form. A parallel **trigram** index does. Both
are required.

## Consequences

- One database file: one transaction, one backup, one recovery story. Agent
  state, audit trail, queue, and memory cannot drift out of sync with each other.
- No second daemon to install or supervise for vector search.
- `better-sqlite3` is a **native module**, so it must build on Linux x86_64 and
  macOS arm64. Both are covered by prebuilt binaries and both are verified in CI.
- Its synchronous API is a feature, not a compromise: with a single writer, async
  interleaving is a source of bugs and no concurrency is being given up.
- `sqlite-vec` is pre-1.0 and does **brute-force** KNN with no approximate index.
  At personal-memory scale brute force is exact and fast enough, which makes this
  an advantage rather than a limitation — but it does not scale indefinitely, and
  the point where it stops being true is worth measuring rather than discovering.
- Two lexical indexes cost write time and disk. Accepted: silently degraded
  retrieval is worse than either.

## Alternatives considered

**`node:sqlite`.** Zero dependencies. Rejected: release-candidate stability and
no support from the migration tooling.

**`bun:sqlite`.** Fast and built in. Rejected with the runtime — see
[0008](0008-nodejs-runtime.md) — and independently for the macOS extension
problem.

**A dedicated vector database.** Better at scale. Rejected: a second store means a
second backup, a second failure mode, and no shared transaction with the state it
describes.

**PostgreSQL.** Rejected: a daemon and an operational burden for a single-user
system, in exchange for concurrency we do not need.

## Revisit when

Measured retrieval latency at realistic corpus size degrades past what brute-force
KNN can carry, or when a target platform appears with no prebuilt native binary.
