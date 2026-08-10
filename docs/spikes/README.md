# Spike reports

Anything version-sensitive or externally dependent is verified before it is
designed around. A spike is a throwaway script with a pass criterion written down
**before** it runs, and a report written after.

| # | Question | Verdict |
|---|---|---|
| [0001](0001-drizzle-kit-typescript-7.md) | Does the migration tool work under TypeScript 7, which shipped without a compiler API? | ✅ Pass |
| [0002](0002-sqlite-vec-fts5-multilingual.md) | Do the vector extension and full-text search work on both targets, does full-text search actually fail on inflected languages, and how far does brute-force vector search scale? | ✅ Pass on both platforms; the failure is real; ceiling measured at ~65k vectors |
| [0003](0003-concurrent-sessions.md) | Can the hardware sustain a dozen concurrent long-lived agent sessions, and is waking a dormant one fast enough? | ✅ Pass — 264 MB per session, flat across scale; wake in 1.7–1.9 s |

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
| Structured agent-to-agent messaging round trip, surviving a restart | This is what "they talk to each other" has to mean in practice |
| Does the quarantine profile actually hold against an escape attempt? | [ADR-0007](../adr/0007-quarantine-untrusted-content.md) is a security claim, and an unverified security claim is a guess |
| Measured retrieval quality: lexical vs vector vs fusion, on a real non-English test set | The fusion weights must come from measurement, not from a plausible-looking default |
| Is structured model output enforced or best-effort? | Decides how much re-validation the kernel needs at the model boundary |
| Sandboxed shell on the primary Linux target | The real isolation boundary, and the one a security claim rests on |
| Provider usage-limit behaviour under load | The budget governor cannot be designed against a guess |
