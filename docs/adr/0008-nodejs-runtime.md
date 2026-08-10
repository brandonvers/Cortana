# 0008. Node.js, not Bun or Deno

**Status:** Accepted
**Date:** 2026-08-10

## Context

Three JavaScript runtimes were candidates for a daemon expected to run for months
without restarting: **Node.js 24 LTS**, **Bun 1.3**, and **Deno 2.9**.

Bun is the obvious performance answer — typically several times faster than Node
on HTTP and I/O benchmarks, with native TypeScript execution and a fast built-in
SQLite. The provider's own CLI is compiled with it.

Two findings reframed the comparison.

**The agent loop does not run in our runtime.** The SDK ships a platform-specific
native binary as an optional dependency and drives it over stdio. Our process
spawns a subprocess and streams JSON. Whatever runtime we choose, the model work
happens somewhere else, so the runtime's raw speed is not on the critical path
for the thing the system actually spends its time doing.

**Our latency budget is dominated by inference, measured in seconds.** A runtime
that shaves milliseconds off request handling moves nothing a user can perceive.
What matters over months of uptime is not leaking memory — and Bun has open
memory-leak reports spanning its 1.3.x line, several against long-running server
workloads. For a daemon, that is precisely the wrong failure mode.

A third, narrower finding: **Bun's built-in SQLite cannot load extensions on
macOS** without the user installing a non-Apple SQLite build and pointing the
runtime at it. This project depends on a SQLite extension (see
[0010](0010-sqlite-storage.md)), so on Bun every macOS user would face an extra
install step to get the memory system working.

## Decision

**Node.js 24 LTS**, pinned in `.nvmrc`, minimum 24.12 for stable type stripping.

Bun remains available as an optional local accelerator for scripts and CI, but
nothing depends on it and the daemon does not run under it.

## Consequences

- The daemon has the most production-hardened runtime, the deepest debugging
  tooling, and the widest library compatibility. Every library in the stack
  targets Node natively.
- **We accept being slower on benchmarks that do not describe our workload.**
- SQLite extensions load with no user-side installation on either target
  platform, because `better-sqlite3` bundles its own SQLite.
- To keep the door open, the code **avoids gratuitous Node-only APIs**. Where a
  standard API does the job, it is used. This is a cheap habit, not a portability
  layer — building an abstraction for a runtime we are not using would be
  speculative work.

## Alternatives considered

**Bun.** Faster, better DX, native TS with no configuration. Rejected on the
memory-stability record for long-running processes and the macOS extension
problem. Both are fixable and neither is permanent.

**Deno.** Good security model and npm compatibility. Rejected because it gains us
nothing here — the security model is redundant with an OS sandbox we need anyway
— while adding friction with native modules and Node-targeting libraries.

## Revisit when

Both of these are true: Bun's long-running memory-leak issues are closed, **and**
its built-in SQLite loads extensions on macOS without a custom build. Neither
alone is sufficient.
