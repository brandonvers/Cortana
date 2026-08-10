# Spike 0002 — sqlite-vec, FTS5, and inflected languages

**Consumes no AI usage.** It is pure local database work — safe to run any number
of times.

This is the Linux half of a spike that already passed on macOS arm64. See
[`docs/spikes/0002-sqlite-vec-fts5-multilingual.md`](../../docs/spikes/0002-sqlite-vec-fts5-multilingual.md)
for the macOS result and the reasoning.

## The question

`sqlite-vec` is a **compiled** SQLite extension. Passing on macOS arm64 says
nothing about Linux x86_64, which is the primary deployment target. If it does not
load there, [ADR-0010](../../docs/adr/0010-sqlite-storage.md) is wrong and the
memory system needs a different design.

The run also re-checks the language finding on Linux, and adds one thing the macOS
run did not measure: **how brute-force KNN scales**, since `sqlite-vec` has no
approximate index and the design assumes exact search is fast enough at personal
scale.

## Pass criteria

1. `sqlite-vec` loads through `better-sqlite3` with no custom SQLite installation
2. A `vec0` table accepts vectors and answers a KNN query correctly
3. FTS5 with `unicode61 remove_diacritics 2` matches accented text typed unaccented
4. FTS5 **fails** to match a stem against an inflected form — demonstrating the
   absence of a stemmer rather than assuming it
5. A `trigram` index **does** match that stem
6. Drizzle works on the same connection
7. Node executes the `.ts` file directly, with no build step
8. KNN over 10,000 vectors of realistic dimension completes in a time that makes
   brute force acceptable — the threshold is **under 50 ms** at p95

## Running it

```bash
cd spikes/0002-sqlite-vec-fts5
pnpm install --ignore-workspace
pnpm start
```

`--ignore-workspace` because this directory is deliberately outside the pnpm
workspace, so a spike can pin whatever versions it needs without touching the
real dependency tree.

`better-sqlite3` is listed under `pnpm.onlyBuiltDependencies` so its native build
script is allowed to run. pnpm blocks build scripts by default, which is the right
default — but on a platform with no prebuilt binary this package has to compile,
and a silently skipped build produces a confusing failure at load time rather than
at install time.

If the compile fails, the build toolchain is missing:

```bash
sudo apt install -y build-essential python3
```

Paste the whole output into the issue or the conversation. The summary block at
the end is what matters, but the version and system lines are what make the result
re-checkable later.
