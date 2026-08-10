# 0013. Modules run in-process by default, with opt-in process isolation

**Status:** Accepted
**Date:** 2026-08-10

## Context

A stated requirement: **a failing part must not stop the system**. Modules are
third-party code by design — a user installs connectors and writes packs — so a
badly behaved module is expected, not exceptional.

Three isolation levels were considered.

**In-process with error boundaries** is fastest and simplest, but an unhandled
rejection, a native crash, or an out-of-memory kill takes the whole process down
regardless of how carefully the boundary is written.

**Worker threads** give an isolated heap and contain most crashes, but workers
cannot use the native SQLite driver directly, so every database access would have
to be marshalled through the kernel — a large cost paid by every module for a
problem most modules do not have.

**A child process per module** gives full isolation and independent restart, at
the price of inter-process communication on every call and many more processes to
supervise.

## Decision

**In-process by default, inside a supervised boundary with timeouts and a circuit
breaker. A module may declare `isolation: 'process'` and get its own process.**

Opt-in isolation is for the cases that need it: a module wrapping a native
binary, one with a known appetite for memory, or one whose code the user does not
fully trust.

## Consequences

- Most modules — tool handlers and scheduled jobs — pay nothing.
- The modules that genuinely need containment can have it without imposing the
  cost on everything else.
- **The honest limitation, stated plainly:** in-process isolation does not
  guarantee what the requirement literally asks for. A segfault or an OOM kill
  ends the process whatever the boundary does.

  So the real answer to "a failing part must not stop the system" is not that
  nothing crashes. It is that **crashing is cheap**: every piece of state is
  durable before it is acknowledged, jobs hold leases that are reclaimed on
  restart, and idempotency keys prevent double execution. A total crash is a
  restart of a few seconds with no lost work.

  That is a stronger guarantee than "the process stays up", because it also holds
  for power cuts, kernel panics, and bugs in our own code — none of which any
  isolation strategy addresses.
- Agents are already separate processes, so agent failure is contained without
  any of this.
- The module host has to be genuinely good at supervision: health checks,
  restart with backoff, and degrading to a working system with one capability
  missing rather than refusing to start.

## Alternatives considered

**Worker threads everywhere.** Rejected: the database marshalling cost falls on
every module, including the majority that would never have crashed.

**A child process per module.** Rejected as the default for IPC cost and
supervision burden. Kept as the opt-in.

**In-process with no escape hatch.** Rejected: it leaves no answer for the
module that genuinely needs containment.

## Revisit when

Operational experience shows in-process modules taking the kernel down often
enough to matter. If that happens, the default flips and the opt-in becomes an
opt-out.
