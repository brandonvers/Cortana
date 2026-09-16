# 0014. The kernel receives and aggregates agent reports

**Status:** Accepted
**Date:** 2026-08-10

## Context

There is one main agent ([CONCEPTS §2](../CONCEPTS.md)), and it is a single
session, so it processes one thing at a time.

When one request is split across several teams, they finish when they finish —
often close together. A design where teams report directly to the main agent has
two failure modes, and both are bad:

- The main agent is **blocked** reading reports while the user is trying to talk
  to it.
- A report arriving while the main agent is mid-turn is **dropped**, or delivered
  in an order that makes the eventual answer incoherent.

There is also a quality argument, and it is the more important one. If three
teams worked on one request and their findings reach the main agent as three
separate arrivals, it narrates three fragments. If they arrive together, it can
synthesise **one answer from the complete picture** — which is the entire reason
for coordinating a team rather than asking one agent.

## Decision

**The kernel receives reports, not the main agent.** Every report is written to
durable storage the moment it arrives, before anything acknowledges it, and the
kernel decides when to deliver.

Delivery rules, in priority order:

1. **A blocker or a decision request is delivered immediately.** A team that is
   stuck, or that needs a call only the main agent can make, does not wait for its
   siblings.
2. **Otherwise the report is held until the request's outstanding work is done**,
   then the whole set is delivered in one turn.
3. **A per-request timeout bounds the hold.** One stalled team cannot indefinitely
   withhold what its siblings already finished. On timeout the main agent receives
   what is ready and is told explicitly what is missing and why.

## Consequences

- **The user is never queued behind the machinery.** The main agent is not blocked
  while teams work, so the user can interrupt, ask for status, redirect, or start
  something unrelated at any moment.
- **One request produces one answer**, assembled by something that saw all of it.
- Progress is **observable without being interruptive**: reports are durable and
  visible on the dashboard whether or not the main agent has read them.
- No report is ever lost, including across a crash mid-delivery.
- **A report may be delivered twice**, and this was not stated until the store
  was built (M4 step 3, 2026-09-16). Delivering a report is a model turn — an
  external effect — so a crash after the turn and before the delivery is
  recorded delivers it again after restart. The store guarantees at-least-once
  delivery and exactly-once *completion*; it cannot guarantee exactly-once
  delivery, and nothing on this side of a model call could. Reports carry ids so
  the main agent's side can recognise a repeat.
- **Cost:** the main agent's answer arrives later than the first team's finding
  would have. That is the trade being made deliberately — completeness over
  immediacy — and rule 1 is the escape hatch for when immediacy actually matters.
- The kernel now needs a per-request model of outstanding work, which is not
  free. It has to know what was dispatched to know when everything is back.
- Aggregation is a **correctness-critical** path. A bug here silently loses work,
  so it belongs in the tested-thoroughly category alongside the queue and the
  policy engine.

## Alternatives considered

**Reports go straight to the main agent.** Simplest. Rejected: it either blocks
the user or drops reports, and it forfeits synthesis.

**Interrupt the main agent on every report.** Rejected: it makes the main agent's
attention a contended resource and produces incoherent answers assembled from
whatever arrived first.

**Aggregate but never time out.** Rejected: one stalled team would withhold
everything indefinitely, converting a partial success into a total failure.

## Revisit when

Real usage shows the hold-until-complete default feels slow. The fix would be
tuning the timeout and widening what counts as "deliver immediately", not
abandoning aggregation.
