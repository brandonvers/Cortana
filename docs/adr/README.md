# Architecture Decision Records

A record of every significant decision, why it went that way, and what would make
us revisit it. This is how a contributor learns *why* rather than just *what*, and
how settled questions stay settled.

## Index

| # | Decision | Status |
|---|---|---|
| [0001](0001-model-access-behind-a-port.md) | Model access runs on the user's own subscription, behind a port | Accepted |
| [0002](0002-project-name.md) | The project is named Cortana, and renaming must stay cheap | Accepted |
| [0003](0003-mit-licence.md) | MIT licence | Accepted |
| [0004](0004-own-the-orchestration-layer.md) | We implement orchestration rather than adopting an experimental upstream feature | Accepted |
| [0005](0005-hybrid-execution-topology.md) | Residents get their own session; ephemeral workers are subagents | Accepted |
| [0006](0006-dormancy-is-the-default.md) | Agents are dormant by default and woken on demand | Accepted |
| [0007](0007-quarantine-untrusted-content.md) | Untrusted content is inspected by a disposable agent before it is trusted | Accepted |
| [0008](0008-nodejs-runtime.md) | Node.js, not Bun or Deno | Accepted |
| [0009](0009-typescript-7-type-stripping.md) | TypeScript 7 with Node's native type stripping | Accepted |
| [0010](0010-sqlite-storage.md) | SQLite via better-sqlite3, with Drizzle, sqlite-vec, and two FTS5 indexes | Accepted |
| [0011](0011-no-redis.md) | No Redis; the queue is SQLite and the bus is in-process | Accepted |
| [0012](0012-local-embeddings.md) | Embeddings run locally, behind an interface | Accepted |
| [0013](0013-module-isolation.md) | Modules run in-process by default, with opt-in process isolation | Accepted |
| [0014](0014-kernel-mediated-reports.md) | The kernel receives and aggregates agent reports | Accepted |
| [0015](0015-structured-output-at-the-model-boundary.md) | Every crossing from a model back into the kernel carries a schema | Accepted |

## When to write one

Write an ADR when a decision would be expensive to reverse, when a reasonable
person would have chosen differently, or when you find yourself explaining the
same reasoning twice.

Do not write one for a choice with an obvious answer and no trade-off.

## Format

```markdown
# NNNN. Title in the imperative

**Status:** Proposed | Accepted | Superseded by [NNNN](...)
**Date:** YYYY-MM-DD

## Context
What is true that forces a decision. Facts, not preferences. Cite sources and
say which claims were verified rather than assumed.

## Decision
What we are doing, stated plainly.

## Consequences
What gets easier, what gets harder, and what we are accepting as a cost.

## Alternatives considered
What else was on the table and why it lost. This is the section that stops the
question being reopened from scratch.

## Revisit when
A concrete condition, not "later".
```

## Superseding

An ADR that turns out to be wrong is **not edited into looking right**. Write a
new one, mark the old one superseded, and say what changed and why. The record of
having been wrong is part of the value.
