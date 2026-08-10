# Spike 0002 — Vector search, full-text search, and inflected languages

**Date:** 2026-08-10
**Verdict:** ✅ **Pass** on macOS arm64. The Linux half is outstanding.
**Decides:** whether the memory design is buildable on the chosen driver, and
whether the multilingual retrieval problem is real

---

## Why this spike existed

Two risks, cheap to test together.

**Extension loading.** `sqlite-vec` is a loadable SQLite extension. Apple's
system SQLite build **disables extension loading**, which is why some drivers
require macOS users to install a separate SQLite. `better-sqlite3` bundles its
own SQLite and should not have this problem — but "should" is not "does".

**Inflected languages.** The design assumed that FTS5 has no stemmer for many
languages, that agglutination therefore breaks lexical search **silently**, and
that a diacritic-folding index plus a trigram index works around it. That
assumption had never been tested, and the whole two-index design rests on it.

## Pass criteria, stated before running

- `sqlite-vec` loads through `better-sqlite3` with no custom SQLite installation
- A `vec0` virtual table accepts vectors and answers a KNN query
- FTS5 with `unicode61 remove_diacritics 2` matches accented text typed without
  accents
- The **absence** of a stemmer is demonstrated rather than assumed
- A `trigram` index matches an inflected form from its stem
- The query layer works on the same connection
- Node runs the `.ts` file directly, with no build step

## Versions

| Component | Version |
|---|---|
| Platform | macOS, arm64 |
| Node.js | 24.19.0 |
| better-sqlite3 | 13.0.3 |
| SQLite (bundled by the driver) | **3.53.4** |
| sqlite-vec | **v0.1.9** |
| drizzle-orm | 0.45.2 |
| typescript | 7.0.2 |

## What happened

```
sqlite=3.53.4  sqlite-vec=v0.1.9
vec0 KNN: [{"id":1,"distance":0},{"id":3,"distance":0.1414213776}]
FTS5, unaccented query  -> match
FTS5, accented query    -> match
FTS5, stem query        -> NO MATCH
trigram, stem query     -> match
query layer raw sql     -> ok
```

Every criterion met. The file was executed with `node smoke.ts` — no loader, no
build step.

## The language result, read carefully

The test text was Hungarian, an agglutinative language FTS5 does not stem. The
target text contained the inflected form *házban* ("in the house"); the stem is
*ház*.

| Query | Result | Meaning |
|---|---|---|
| `hazban` — inflected, no accents | **match** | `remove_diacritics 2` folds accented characters. Users who type without accents are served. |
| `házban` — inflected, accented | **match** | exact form, as expected |
| `haz` — the stem | **no match** | **The assumption is confirmed.** FTS5 has no stemmer for this language, so a stem does not reach its inflected forms. |
| `ház` — the stem, against a trigram index | **match** | the workaround does what it was supposed to |

The third row is the finding. A lexical index alone **loses inflected matches
without any error**: the query succeeds and returns nothing. The empty result then
enters the rank fusion as if it were a genuine "nothing relevant here", degrading
every affected query with no signal that anything is wrong.

This is the most expensive class of bug to find late, because there is nothing to
notice — only retrieval that is quietly worse than it should be.

## Gotchas worth encoding

1. **`vec0` primary keys must be bound as `BigInt`.** A plain JS number fails with
   `Only integers are allows for primary key values` — a misleading message, since
   the value *was* an integer.
2. **Vectors must be bound as a `Buffer`, not a typed array.**
3. Both belong behind a small typed helper so no caller ever meets them.

## What it changes

- **`better-sqlite3` is confirmed**, with a concrete reason rather than a
  preference: it bundles SQLite 3.53.4 and loads extensions with no user-side
  installation on macOS. Recorded in
  [ADR-0010](../adr/0010-sqlite-storage.md).
- **Two lexical indexes are a requirement, not an option** — diacritic-folding for
  accent-insensitive matching, trigram to survive inflection.
- **Measured retrieval quality is still required.** This spike proves the
  mechanisms work. It says nothing about how the fusion should weight them, which
  has to come from a real test set in the target language.

## Outstanding

Repeat on the primary Linux target. The extension is a compiled artefact, and
passing on macOS arm64 says nothing about a different platform and architecture —
which is where this software is actually meant to run.
