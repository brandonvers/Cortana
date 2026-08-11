# 0006. Agents are dormant by default

**Status:** Accepted
**Date:** 2026-08-10
**Updated:** 2026-08-11 — measured in [spike 0003](../spikes/0003-concurrent-sessions.md);
the decision stands, and the latency criterion it was thought to carry moved to the product brief

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

## What dormancy costs, measured

[Spike 0003](../spikes/0003-concurrent-sessions.md) measured this on the target
hardware, under a profile carrying a real persona, a memory tool surface, file
tools and setting sources.

| | warm turn (kept awake) | pre-warmed wake (was dormant) | dormancy costs |
|---|---|---|---|
| realistic / sonnet | 3,290 ms | 3,095 ms | **−195 ms** |
| minimal / sonnet | 2,882 ms | 2,330 ms | **−552 ms** |
| minimal / haiku | 1,800 ms | 2,456 ms | **+656 ms** |

**Dormancy is close to free, and the sign of the difference is not fixed.** A
pre-warmed wake is a *first* prompt on a session whose prompt cache is cold; a
warm turn is a *later* prompt on a session whose cache is hot but which now also
carries the earlier exchange. Which effect wins depends on the model. Where
generation dominates (sonnet), the extra input of a continuing conversation costs
more than a cold cache and the wake comes out ahead. Where generation is cheap
(haiku), the cold cache is visible and the wake costs about 0.65 s more.

The worst case observed is therefore **a few hundred milliseconds added to a
multi-second reply**, against a cold start of 5.4–6.2 s that pre-warming removes.

## Consequences

- A large roster becomes affordable, because two or three agents are awake at any
  moment rather than twelve.
- **Waking costs little, but pre-warming is what makes that true.** Without it,
  waking means a full cold start of 5.4–6.2 s — roughly double a turn. The
  presence engine is therefore load-bearing, not a nicety.
- **A dormant agent's latency is bounded by the product's turn latency, not by
  dormancy.** Whatever the system's baseline response time is, dormancy does not
  meaningfully add to it. Making replies faster is a separate problem with
  separate levers, and it is not solved by keeping agents awake.
- Anything an agent must remember has to be **outside the session**, in the
  memory system. This is a constraint the design has to honour everywhere: a
  dormant agent that loses state was never really resident. It aligns with the
  kernel rule that no state exists only inside a session.
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

## A note on what this ADR does not decide

The spike that produced these numbers originally carried a criterion reading
"pre-warmed wake, median under 3 s", attributed to this ADR. **That threshold was
never in this ADR, and it was not measuring what this ADR decides.** Three seconds
is a claim about how fast a reply should be, which is a product question and now
lives in the product brief; whether agents should sleep turns on the *difference*
between waking one and never letting it sleep, which is the table above.

The distinction matters beyond bookkeeping: the wrongly-attributed criterion
failed at 3,095 ms and would have been read as "dormancy is too slow", when the
same run shows dormancy costing 195 ms less than nothing. The available fixes
would all have been aimed at the wrong component.

## Revisit when

- **Waking costs more than about a second over a warm turn** on a model or
  profile actually in use. That is spike 0003's criterion 4 and it is checked on
  every run. If it breaks, the idle TTL and the pre-warm strategy change — but
  dormancy itself is forced by arithmetic, not by preference.
- **`opus` is measured.** All three rows above are sonnet or haiku. If the main
  agent runs on opus, the cold-cache penalty may sit differently against
  generation time, and the sign of the difference could change again.
- **Working memory is measured.** These are idle figures; a resident
  mid-conversation holds more, and a dormancy policy that ignores growth during
  work is only half a policy.
