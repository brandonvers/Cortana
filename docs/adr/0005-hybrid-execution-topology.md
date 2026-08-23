# 0005. Residents get their own session; ephemeral workers are subagents

**Status:** Accepted
**Date:** 2026-08-10

## Context

The product requires persistent specialists with their own identity and memory
that can talk to each other, and it requires cheap throwaway workers inside a
task. There were three ways to run them.

**Everything as subagents of one session** is the cheapest: one process, one
context window to warm, native support. But subagents report only to their
caller — **they cannot talk to each other** — so the debate mode described in
[CONCEPTS](../CONCEPTS.md) would not be a debate, and a specialist would have no
durable identity across jobs.

**Everything as its own long-lived session** gives real identity, real
agent-to-agent conversation, and crash isolation. It costs one context window per
agent and one process to supervise per agent.

The upstream runtime supports nested subagents to a configurable depth, with a
default of 3 and a cap on concurrency. Sessions do not nest, so **the depth
counter resets at each session boundary**.

## Decision

**Hybrid.**

- **Resident agents each own a long-lived session.** Identity, memory,
  transcript, and the ability to converse with peers. A crash takes down one
  agent, not the roster.
- **Ephemeral workers run as subagents** of whichever resident owns the task,
  where only the result matters and a separate session would be waste.

## Consequences

- Debate mode is a real debate: the participants can address each other.
- Crash isolation comes for free at the resident boundary.
- Because residents are sessions rather than subagents, nesting depth resets at
  each boundary: main agent → resident (fresh) → subagent → child. More headroom
  than the raw limit implies.
- **Token cost scales with the number of awake residents.** This is the real cost
  of the decision, and it is what forces
  [0006](0006-dormancy-is-the-default.md) — without dormancy, a roster of a dozen
  agents is unaffordable.
- More processes to supervise, and the supervision has to be genuinely good:
  leases, health checks, restart with backoff.

## Alternatives considered

**All subagents.** Rejected: no peer conversation, no durable identity. It would
have made the product a task-parallelism tool rather than a team.

**All sessions, including throwaway workers.** Rejected as waste. A worker that
extracts three fields from a document does not need identity, memory, or a
transcript.

## Revisit when

Measurement contradicts the assumption.

> **Updated: 2026-08-10 — measured in [spike 0003](../spikes/0003-concurrent-sessions.md),
> which records this ADR as confirmed.** 263–264 MB per idle session, flat across
> scale, and ~$0.203 per turn on the realistic profile on `sonnet`.
>
> The memory figure bounds **idle residents only** — it was taken after
> `startup()` with no prompt sent — so a session doing work is not covered by it.
> The revisit condition now reads against these numbers: if per-session memory or
> per-turn cost moves materially past them, the split between what deserves a
> session and what does not moves, rather than the topology being abandoned.
