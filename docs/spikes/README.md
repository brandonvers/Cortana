# Spike reports

Anything version-sensitive or externally dependent is verified before it is
designed around. A spike is a throwaway script with a pass criterion written down
**before** it runs, and a report written after.

| # | Question | Verdict |
|---|---|---|
| [0001](0001-drizzle-kit-typescript-7.md) | Does the migration tool work under TypeScript 7, which shipped without a compiler API? | ✅ Pass |
| [0002](0002-sqlite-vec-fts5-multilingual.md) | Do the vector extension and full-text search work on both targets, does full-text search actually fail on inflected languages, and how far does brute-force vector search scale? | ✅ Pass on both platforms; the failure is real; ceiling measured at ~65k vectors |
| [0003](0003-concurrent-sessions.md) | Can the hardware sustain a dozen concurrent long-lived agent sessions, and is waking a dormant one fast enough? | ✅ Pass — 264 MB per session, flat across scale; dormancy costs 656 ms per wake |
| [0004](0004-containment.md) | Does the quarantine profile hold against injection, and does the OS sandbox actually contain? | ✅ Pass — zero escapes, and bubblewrap contains on the target |
| [0005](0005-durable-bus.md) | Does an acknowledged write survive SIGKILL, and do the delivery rules work against a real store? | ✅ Pass on both filesystems — nothing acknowledged was ever lost |
| [0006](0006-multilingual-retrieval.md) | Does retrieval work in a language the stemmer does not cover, and which embedding model should be the default? | ⚠️ `bge-m3` chosen on measurement — but **fusion failed**: the lexical indexes make the best model worse |

## Rules

- A spike lives in `spikes/NN-name/` and is **throwaway**. It is never merged into
  `packages/`.
- Its **pass criterion is stated before it runs.** Deciding afterwards what would
  have counted as success is not a test.
- Its report records: what was tested, **exact versions**, what happened, the
  verdict, and **what it changes in the architecture**.
- **A spike that invalidates part of the design is a success**, not a setback.
  Say so plainly and propose the revision.
- If a spike is turning into a project, it is the wrong spike. Stop and report.

## Why the versions are recorded so precisely

This project builds on a surface that ships weekly. A result is only meaningful
alongside the versions that produced it, and a report without them cannot be
re-checked after an upgrade. Every table of versions in these reports exists so
that a future reader can tell whether the finding still holds.

## Outstanding

The spikes that must complete before implementation begins, in order:

| Question | Why it is blocking |
|---|---|
| Retrieval quality on the **private** set of real material | [0006](0006-multilingual-retrieval.md) chose `bge-m3` on a set whose queries were written alongside its items. Real material can overturn it, and if it does, it wins |
| Does the lexical index earn its place as a **specialist** rather than a voter? | [0006](0006-multilingual-retrieval.md) showed unconditional fusion making the best model worse. The replacement design is untested |
| Is structured model output enforced or best-effort? | Decides how much re-validation the kernel needs at the model boundary |
| Claude Code's *use* of the sandbox, as opposed to bubblewrap itself | [0004](0004-containment.md) proved the primitive contains; the policy translation above it is untested |
| Provider usage-limit behaviour under load | The budget governor cannot be designed against a guess |
