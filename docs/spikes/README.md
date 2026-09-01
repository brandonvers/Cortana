# Spike reports

Anything version-sensitive or externally dependent is verified before it is
designed around. A spike is a throwaway script with a pass criterion written down
**before** it runs, and a report written after.

| # | Question | Verdict |
|---|---|---|
| [0001](0001-drizzle-kit-typescript-7.md) | Does the migration tool work under TypeScript 7, which shipped without a compiler API? | ✅ Pass |
| [0002](0002-sqlite-vec-fts5-multilingual.md) | Do the vector extension and full-text search work on both targets, does full-text search actually fail on inflected languages, and how far does brute-force vector search scale? | ✅ Pass on both platforms; the failure is real; ceiling measured at ~65k vectors |
| [0003](0003-concurrent-sessions.md) | Can the hardware sustain a dozen concurrent long-lived agent sessions, and is waking a dormant one fast enough? | ✅ Pass — 264 MB per session, flat across scale; dormancy is close to free (−195 ms on the realistic profile; −552 ms to +656 ms across profiles, sign model-dependent) |
| [0004](0004-containment.md) | Does the quarantine profile hold against injection, and does the OS sandbox actually contain? | ✅ Pass — zero escapes, and bubblewrap contains on the target |
| [0005](0005-durable-bus.md) | Does an acknowledged write survive SIGKILL, and do the delivery rules work against a real store? | ✅ Pass on both filesystems — nothing acknowledged was ever lost |
| [0006](0006-multilingual-retrieval.md) | Does retrieval work in a language the stemmer does not cover, and which embedding model should be the default? | ⚠️ `bge-m3` chosen on measurement — but **fusion failed**: the lexical indexes make the best model worse |
| [0007](0007-lexical-routing.md) | Is the lexical index a specialist or an unconditional voter? | ❌ **Failed its own pre-registered criterion and answers nothing.** Kept as the record of what a fifth attempt would need |
| [0008](0008-sandbox-integration.md) | Does Claude Code's *use* of the sandbox hold, and does it fail loudly? | ⚠️ **One finding; the rest struck.** `bwrapPath` was supplied on a channel documented to ignore it, so the substitution never took effect |
| [0009](0009-structured-output.md) | Is structured output enforced, and what does the kernel see when it is not? | ✅ **Closes ADR-0015's cost question** — the spread is prompt-cache writes, not retries — and withdraws a fabrication finding that was false |
| [0010](0010-non-bash-containment.md) | Does the sandbox constrain in-process tools, and does `failIfUnavailable` change anything? | ✅ **Refutes ADR-0007's "enforced twice"** for the profile it governs — the sandbox does not reach in-process tools; path-scoped deny rules do. `failIfUnavailable` measured for the first time |
| [0011](0011-quarantine-escape.md) | Does either lock alone contain an in-process tool, and can delegation get around them? | ✅ **"Enforced twice" holds**, measured against a positive control — but only with `//abs/path/**`; the plain spelling leaked 4/4 |
| [0012](0012-bash-read-channel.md) | Is Bash a read channel that both locks miss? | ⚠️ **Yes, under the shipped default.** `autoAllowBashIfSandboxed: true` keeps the policy callback out of the path; three settings close it |
| [0013](0013-usage-headroom.md) | Can the budget governor see the wall before it hits it? | ✅ **Yes, and it is warned.** Per-window utilization is live and the provider pushes a threshold warning; the **weekly** window binds, not the five-hour one |

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

Each row blocks **the milestone it belongs to**, not all implementation.

That is a change from the original rule, and the reason is that the rule outlived
the list it was written for. It was set when the outstanding set was short and it
was not obvious what each item gated. It now is: both open questions are about
retrieval, which is [M5](../RELEASING.md). The assumptions M1, M2 and M3 rest on
were measured by spikes that have closed —

| Milestone | Rests on | Status |
|---|---|---|
| M1 — kernel, storage, migrations, writer queue | [0001](0001-drizzle-kit-typescript-7.md), [0002](0002-sqlite-vec-fts5-multilingual.md), [0005](0005-durable-bus.md) | closed |
| M2 — model runner port, audit, cost | [0003](0003-concurrent-sessions.md), [0009](0009-structured-output.md), [0013](0013-usage-headroom.md) | closed |
| M3 — chat, conversation loop, approvals | [0004](0004-containment.md), [0008](0008-sandbox-integration.md), [0010](0010-non-bash-containment.md), [0011](0011-quarantine-escape.md), [0012](0012-bash-read-channel.md) | closed |
| M4 — the roster, delegation, report aggregation | [0003](0003-concurrent-sessions.md), [0005](0005-durable-bus.md) | closed |
| M5 — memory, embeddings, hybrid retrieval | [0006](0006-multilingual-retrieval.md), [0007](0007-lexical-routing.md) | **open, below** |

— so holding M1 on a corpus that only decides M5 buys no safety and costs the
schedule. **M5 does not start until the rows below are closed.**

One coupling to keep in view rather than assume away: if the private set
overturns `bge-m3`, the embedding **dimension** changes.
[ADR-0012](../adr/0012-local-embeddings.md) already records it as a parameter
rather than a constant, and with no vectors stored the change is free — but M1's
schema work must not hard-code 1024.

| Question | Blocks | Why it is blocking |
|---|---|---|
| Retrieval quality on the **private** set of real material | **M5** | [0006](0006-multilingual-retrieval.md) chose `bge-m3` on a set whose queries were written alongside its items. Real material can overturn it, and if it does, it wins |
| Does the lexical index earn its place as a **specialist** rather than a voter? | **M5** | **Still open after [0007](0007-lexical-routing.md) failed to answer it.** The fusion rule in [CONCEPTS §8](../CONCEPTS.md) is now marked open with evidence against one form of it and none for the specified form. 0007's closing section lists what the measurement needs — it is a benchmark, not a spike |
| ~~Is the query embed serial with the turn or concurrent with the wake?~~ | — | **Decided by [ADR-0016](../adr/0016-retrieval-starts-with-the-wake.md)**: concurrent. It rests on one unverified assumption — that retrieved context can reach a session already waking — which is a mechanism question for the memory spike rather than a blocker here |
| ~~Provider usage-limit behaviour under load~~ | — | **Closed by [0013](0013-usage-headroom.md)** for everything the governor needs in order to avoid the limit. What happens *at* the limit stays unmeasured on purpose — the measurement costs the operator their working window — and is a robustness question rather than a blocker |
