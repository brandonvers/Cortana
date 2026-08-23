# 0016. Retrieval starts when the message arrives, not when the model is ready

**Status:** Proposed
**Date:** 2026-08-16

## Context

[Spike 0006](../spikes/0006-multilingual-retrieval.md) measured a query embed at
roughly **620 ms** on CPU, and recorded that the number means two different
things depending on an architectural choice nobody had made:

> If retrieval runs concurrently with waking the agent and assembling its
> context, the 620 ms disappears entirely and no hardware change is needed. If it
> is serial, it is 19% on top of every turn and the driver matters.

That question was never written down anywhere outside the spike report until a
documentation audit surfaced it. It is currently blocking more than it looks:

- **The GPU decision is deferred on it.** The Quadro P620 needs the 570 or 580
  driver branch; 590 dropped Pascal support. That is a real piece of work on the
  server, and it is only worth doing if the embed is on the critical path.
- **[ADR-0006](0006-dormancy-is-the-default.md)'s latency budget depends on it.**
  Spike 0003 measured dormancy as close to free — −195 ms on the realistic
  profile — so a serial 620 ms embed would be, by a wide margin, the largest
  single component of response time.

## Decision

**First-pass retrieval begins the moment an inbound message is accepted, in
parallel with waking the session. It does not wait for the model.**

This is possible because the first pass needs nothing the model produces. The
query *is* the inbound message. Embedding it, searching the vector index, running
the lexical index and fusing the results are all pure functions of text the
kernel already holds — the same text it is about to hand to a session it is
waking anyway.

So the two run side by side, and the turn waits for whichever finishes last
rather than for their sum.

**Any model-mediated query rewriting is a second pass, and is not on the default
path.** Expanding or reformulating a query with the model cannot start before the
model is up, so it is serial by construction and pays full price. The design does
not get to have that for free, and therefore does not assume it: the common case
must be answerable from the first pass.

## Consequences

- **The 620 ms leaves the critical path** in the common case, and the response
  time accepted in the product brief stands without hardware work.
- **The GPU becomes an optimisation rather than a requirement.** The driver-branch
  work on the server can be scheduled rather than blocking, and the decision to
  stay on 570/580 for Pascal is unchanged but no longer urgent.
- **The kernel must be able to hand retrieved context to a session that is
  already waking.** This is the load-bearing assumption and it is **unverified**:
  nothing has measured whether the SDK lets context be injected into a session
  between `startup()` and the first prompt, or whether it must be part of the
  prompt itself. If it must be part of the prompt, the parallelism still works —
  the kernel simply holds the prompt until both are ready — but the wake and the
  embed must then both complete before the turn starts, which is still a maximum
  rather than a sum.
- **Retrieval failure must not block the turn.** Running concurrently means the
  turn can start without results if retrieval is slow or errors; the agent gets
  less context rather than a stalled response. What "less context" degrades to is
  a design question this ADR does not settle.
- **A cold vector index changes the arithmetic.** 620 ms was measured on a warm
  Ollama with the model resident. First-call load time is not in that figure and
  is not measured.

## Alternatives considered

**Serial retrieval, then wake.** The straightforward implementation: retrieve,
assemble context, start the session with everything in hand. Rejected because it
adds the full embed latency to every turn for no benefit — the two operations
have no data dependency in the first-pass case.

**Retrieve only when the agent asks.** Memory as a tool the agent calls, rather
than context assembled for it. This is genuinely attractive and
[CONCEPTS §8](../CONCEPTS.md) already describes memory as addressed "as a tool
rather than stuffed into every prompt". Rejected *as the default* because it makes
retrieval latency serial **and** costs an extra model turn to decide to ask.
Retained as the mechanism for the cold tier, where explicit search is the
documented access path.

**Speculative retrieval before the message is complete.** Start embedding on a
partial message. Rejected as premature: it optimises a path not yet measured, and
the failure mode — embedding a prefix that changes meaning by the end — is
exactly the kind of subtlety this project has been burned by.

## Revisit when

Wake latency is measured on the real memory system and turns out to exceed the
embed time, which would make the embed free rather than merely parallel. Or a
query-rewriting pass proves necessary for the common case, in which case the
first-pass-only assumption breaks and the 620 ms returns to the critical path.
