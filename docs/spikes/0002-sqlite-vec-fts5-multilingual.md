# Spike 0002 — Vector search, full-text search, and inflected languages

**Date:** 2026-08-10
**Verdict:** ✅ **Pass** on both target platforms
**Decides:** whether the memory design is buildable on the chosen driver, whether
the multilingual retrieval problem is real, and how far brute-force search scales

---

## Why this spike existed

Three risks, cheap to test together.

**Extension loading.** `sqlite-vec` is a **compiled** SQLite extension. Apple's
system SQLite build disables extension loading, which is why some drivers require
macOS users to install a separate SQLite. `better-sqlite3` bundles its own SQLite
and should not have this problem. And passing on macOS says nothing about Linux,
which is the primary deployment target — a compiled artefact has to be tested
where it will actually run.

**Inflected languages.** The design assumed FTS5 has no stemmer for many
languages, that agglutination therefore breaks lexical search **silently**, and
that a diacritic-folding index plus a trigram index works around it. That
assumption had never been tested, and the two-index design rests on it.

**Scale.** `sqlite-vec` has no approximate index, so every query scans every
vector. [ADR-0010](../adr/0010-sqlite-storage.md) asserts exact search is fast
enough at personal scale. "Fast enough" needs a number.

## Pass criteria, stated before running

1. `sqlite-vec` loads through `better-sqlite3` with no custom SQLite installation
2. A `vec0` table accepts vectors and answers KNN correctly
3. FTS5 with `unicode61 remove_diacritics 2` matches accented text typed unaccented
4. FTS5 **fails** to match a stem against an inflected form — demonstrated, not assumed
5. A `trigram` index **does** match that stem
6. Drizzle works on the same connection
7. Node executes the `.ts` file directly, with no build step
8. KNN over 10,000 vectors of 384 dimensions completes under **50 ms** at p95

## Environments

| | Development machine | **Primary deployment target** |
|---|---|---|
| OS | macOS 26, arm64 | **Debian GNU/Linux 13 (trixie)**, x64 |
| CPU | Apple M2 × 8 | Intel Xeon E5-2695 v2 @ 2.40 GHz × 48 |
| Memory | 8 GB | 62.9 GB |
| Node.js | 24.19.0 | 24.19.0 |
| better-sqlite3 | 13.0.3 | 13.0.3 |
| SQLite (bundled) | **3.53.4** | **3.53.4** |
| sqlite-vec | **v0.1.9** | **v0.1.9** |
| drizzle-orm | 0.45.2 | 0.45.2 |

## Result

**All eight criteria passed on both platforms.** Identical SQLite and extension
versions, identical functional behaviour. The native module compiled from source
on Debian (`gyp info ok`) rather than using a prebuilt binary, which is the more
demanding path and the one that passed.

## The language result, read carefully

The test text was Hungarian, an agglutinative language FTS5 does not stem. The
target text contained the inflected form *házban* ("in the house"); the stem is
*ház*. Identical on both platforms:

| Query | Result | Meaning |
|---|---|---|
| `hazban` — inflected, no accents | **match** | `remove_diacritics 2` folds accented characters. Users who type without accents are served. |
| `házban` — inflected, accented | **match** | exact form, as expected |
| `haz` — the stem | **no match** | **The assumption is confirmed.** No stemmer, so a stem does not reach its inflected forms. |
| `ház` — the stem, trigram index | **match** | the workaround does what it was supposed to |

The third row is the finding. A lexical index alone **loses inflected matches with
no error**: the query succeeds and returns nothing. That empty result then enters
the rank fusion as a genuine "nothing relevant here", degrading every affected
query with no signal that anything is wrong.

This is the most expensive class of defect to find late, because there is nothing
to notice — only retrieval that is quietly worse than it should be.

## Scale, and the number this produced

| | macOS (M2) | Debian (Xeon E5-2695 v2) |
|---|---|---|
| Insert 10,000 × 384d | 247 ms | 1,102 ms |
| KNN k=10, p50 | 0.8 ms | 7.0 ms |
| KNN k=10, **p95** | **0.9 ms** | **7.5 ms** |

The server is roughly **8× slower per query**, which is what a 2013-era Ivy Bridge
core looks like next to an M2. Both are comfortably under the 50 ms threshold, so
the criterion passes — but the server number is the one that matters, and it
yields a limit the design did not previously have:

**Brute-force KNN scales linearly with corpus size.** At 7.5 ms per 10,000
vectors, the 50 ms budget is exhausted at roughly **65,000 vectors** on this
hardware.

That is not a problem today and it is not close to one. It is a number worth
having written down, because the alternative is discovering it as unexplained
slowness in a year. Three things follow:

- The tier design already helps. If vector search is scoped to the warm and shared
  tiers rather than the whole archive, the working set stays far below the limit
  and the cold tier is reached by explicit search instead.
- **The limit should be measured again, not extrapolated**, if the corpus ever
  approaches roughly 50,000 items. Linear extrapolation from one data point is a
  hypothesis.
- Faster hardware moves the limit by its single-thread performance, not by core
  count. This query does not parallelise across the 48 cores available.

## Gotchas worth encoding

1. **`vec0` primary keys must be bound as `BigInt`.** A plain JS number fails with
   `Only integers are allows for primary key values` — misleading, since the value
   *was* an integer.
2. **Vectors must be bound as a `Buffer`**, not a typed array.
3. Both belong behind a small typed helper so no caller ever meets them.

## What it changes

- **`better-sqlite3` is confirmed on both targets.** It bundles SQLite 3.53.4 and
  loads extensions with no user-side installation, and it compiles cleanly on
  Debian 13. [ADR-0010](../adr/0010-sqlite-storage.md) stands.
- **Two lexical indexes are a requirement, not an option** — diacritic-folding for
  accent-insensitive matching, trigram to survive inflection.
- **A documented scale ceiling of roughly 65,000 vectors** on the reference
  hardware, with the tiering strategy as the answer for growing past it.
- **Measured retrieval quality is still required.** This spike proves the
  mechanisms work. It says nothing about how the fusion should weight them, which
  has to come from a real test set in the target language.

## Reproducing it

The harness is committed at [`spikes/0002-sqlite-vec-fts5/`](../../spikes/0002-sqlite-vec-fts5/).
When a dependency moves, re-running it is how anyone finds out whether this result
still holds.
