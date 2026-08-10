# 0006. Agents are dormant by default

**Status:** Accepted
**Date:** 2026-08-10

## Context

[0005](0005-hybrid-execution-topology.md) gives every resident agent its own
session, and each session holds a context window that costs tokens to warm and
memory to keep.

The expected roster is three to five agents. A user on a larger plan wanting
eight to twelve is a case that has to work, not a case to discourage. Twelve
permanently awake sessions is not affordable on any consumer plan, and most of
them would be idle most of the time — a mail specialist has nothing to do at
three in the morning, and a research specialist may go days between jobs.

The naive fix is a smaller roster. That solves the cost by removing the product.

## Decision

**Residency is an identity, not a running process.** An agent's default state is
`dormant`: its definition and memory exist, no session does, and it costs
nothing.

| State | Meaning |
|---|---|
| `dormant` | Definition and memory only. **Default.** |
| `warming` | Session starting, context loading |
| `active` | Working |
| `idle` | Alive, no work; returns to `dormant` after a configurable TTL |

An agent wakes on delegation, a scheduled job, being addressed directly, a
subscribed event, or a prediction from the presence engine.

## Consequences

- A large roster becomes affordable, because two or three agents are awake at any
  moment rather than twelve.
- **Waking has latency.** A dormant agent must start a session and load context
  before it can answer, which is why pre-warming exists and why wake latency is
  measured in a spike rather than assumed acceptable.
- Anything an agent must remember has to be **outside the session**, in the
  memory system. This is a constraint the design has to honour everywhere: a
  dormant agent that loses state was never really resident. It aligns with the
  kernel rule that no state exists only inside a session.
- The presence engine becomes load-bearing rather than a nicety, because
  pre-warming is what hides the latency.
- Model and effort are naturally chosen at wake time, which is also when changing
  them is free — see [CONCEPTS §3.4](../CONCEPTS.md).

## Alternatives considered

**Keep every resident awake.** Simplest, no latency. Rejected on cost: it caps
the roster at a size that undercuts the product.

**Keep only the main agent awake, spawn everything else per task.** Cheapest.
Rejected because it erases the distinction between a resident and an ephemeral
worker, which is the thing that makes a specialist a colleague rather than a
function call.

**An LRU cache of live sessions.** Effectively what this is, with an explicit
state machine instead of an implicit eviction policy — chosen because the states
are observable, auditable, and something the user can reason about on a dashboard.

## Revisit when

Wake latency is measured. If pre-warming cannot bring it under a few seconds, the
idle TTL and the pre-warm strategy change — but dormancy itself is forced by
arithmetic, not by preference.
