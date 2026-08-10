# Spike 0005 — Does the bus survive being killed?

**Part A is free** and is the part that matters. **Part B uses a little AI usage**
and can be skipped with `FREE_ONLY=1`.

This tests the claim that makes everything else in the design safe:

> **Durable before acknowledged.** Anything that can be lost on `SIGKILL` must be
> in SQLite before it is acknowledged.

Every other resilience claim in this project reduces to that one. "A failing part
must not take the system with it" is not a promise that nothing crashes — it is a
promise that **crashing is cheap**, and that promise is worth exactly as much as
this spike says it is.

It also tests the delivery rules from
[ADR-0014](../../docs/adr/0014-kernel-mediated-reports.md), which decide what the
main agent sees when several teams finish at once.

## Why a spike rather than a unit test

A unit test can prove the aggregation logic. It cannot prove durability, because
durability is a claim about what happens when the process **stops existing** in
the middle of a write. That needs a real child process, a real `SIGKILL` at an
unpredictable moment, and a real restart reading a real file.

## Pass criteria

### Part A — durability and delivery (free)

| # | Criterion |
|---|---|
| A1 | Every message the writer **acknowledged** is present after `SIGKILL` — no acknowledged write is lost |
| A2 | No partially-written message is readable — a message is either wholly there or wholly absent |
| A3 | Leases held by the killed process are **reclaimed** on restart, so no work is stranded |
| A4 | Redelivery after a crash does not **double-execute** — the idempotency key holds |
| A5 | Reports for one request are **held until the request completes**, then delivered together |
| A6 | A blocker is delivered **immediately**, ahead of its siblings |
| A7 | A stalled sibling cannot withhold the rest indefinitely — the **timeout** releases what is ready, and says what is missing |

### Part B — real agents, structured payloads (uses AI)

| # | Criterion |
|---|---|
| B1 | Two agent sessions exchange a **structured** object through the bus, not prose |
| B2 | The round trip is measured, so the coordination overhead is a number rather than a guess |

## Running it

```bash
cd spikes/0005-durable-bus
pnpm install

FREE_ONLY=1 pnpm start   # part A only — the durability tests
pnpm start               # everything
```

`SIGKILL_AT` sets how many messages the writer acknowledges before it is killed;
the default varies the timing across several rounds so the kill lands at
different points in the write path.

Paste the whole output.
