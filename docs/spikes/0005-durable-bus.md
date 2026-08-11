# Spike 0005 — Does the bus survive being killed?

**Date:** 2026-08-10
**Verdict:** ✅ **Pass** — all nine criteria, on both platforms
**Decides:** whether principle 2 — *durable before acknowledged* — describes
something real, and whether the delivery rules in
[ADR-0014](../adr/0014-kernel-mediated-reports.md) work against a real store

---

## Why this spike existed

Principle 2 says anything that can be lost on `SIGKILL` must be in SQLite before
it is acknowledged. Every other resilience claim in this project reduces to it.
"A failing part must not take the system with it" is not a promise that nothing
crashes — it is a promise that **crashing is cheap**, and that promise was worth
whatever this spike said it was worth.

Durability cannot be unit tested. It is a claim about what happens when a process
**stops existing** mid-write, so it needs a real child, a real `SIGKILL`, and a
real file reopened afterwards.

## Environment

| | Development machine | **Primary deployment target** |
|---|---|---|
| OS | macOS 26, arm64 | **Debian GNU/Linux 13**, x64 |
| Filesystem | APFS | ext4 |
| Node.js | 24.19.0 | 24.19.0 |
| better-sqlite3 | 13.0.3 | 13.0.3 |

The store uses WAL with `synchronous = FULL`, one explicit transaction per
message, and an idempotency table.

## A1/A2 — kill the writer, then audit

Four kills at different points in a 600-message sequence.

| Killed after | On disk | Lost | Torn |
|---|---|---|---|
| 37 acks | **38** | 0 | 0 |
| 113 acks | 113 | 0 | 0 |
| 251 acks | 251 | 0 | 0 |
| 409 acks | 409 | 0 | 0 |

**Zero acknowledged writes lost. Zero torn payloads.** Each payload carries its
own sequence number twice, so an inconsistent record would be detectable rather
than merely unlikely.

### The 38 is the interesting number

In the first Linux round, **38 messages were on disk but only 37 had been
acknowledged**. That is not a discrepancy to explain away — it is the result
working correctly, and it says two things worth keeping.

First, **the kill landed inside the write path**, not in a quiet moment between
operations. A test where the two numbers always match exactly might only be
proving that `SIGKILL` arrives between writes.

Second, **the guarantee is one-directional, and this is the safe direction.** A
write that landed without being acknowledged costs nothing: the sender never
learned it succeeded, so it will be retried, and the idempotency table makes the
retry harmless (A4). A write that was acknowledged but did not land is the
catastrophic case — a caller that believes something is durable when it is not.
Only the second direction is a defect, and it did not occur.

## A3/A4 — leases and idempotency

```text
leased by a process that then died   5
reclaimed on restart                 5
applyOnce results                    true, false, false
side effects executed                1
```

Leases held by a process that died are reclaimed at boot rather than stranding
the work, and a message redelivered three times had effect exactly once.

Those two together are what make the safe direction above actually safe:
redelivery after a crash is expected, and it is only harmless because
`applyOnce` is.

## A5/A6/A7 — the delivery rules from ADR-0014

```text
after 1 of 3 reports    0 delivered · holding for siblings · 2 missing
after 2 of 3 reports    0 delivered · holding for siblings · 1 missing
after 3 of 3 reports    3 delivered · request complete — delivered together
one report + a blocker  1 delivered · blocker — delivered immediately
2 of 3, deadline passed 2 delivered · partial delivery · 1 missing
```

The rules behave as specified against a real store: one request's reports arrive
together so the main agent can synthesise rather than narrate, a blocker does not
wait for its siblings, and a stalled sibling cannot withhold what the others
finished — the partial delivery names what is missing rather than pretending to
be complete.

## B — a structured payload between two agents

```text
producer turn            11,198 ms
structured payload       {"finding":"7 is a prime number…","confidence":"high"}
bus write + aggregate    1.1 ms
```

The object survived the bus intact, as an object. That is the capability which
ruled out the upstream plain-text transport in
[ADR-0004](../adr/0004-own-the-orchestration-layer.md).

**The bus costs 1.1 ms against an 11,198 ms model turn.** Coordination overhead
is four orders of magnitude below inference. Whatever eventually makes this system
slow, it will not be the message bus — which also means there is no case for
trading durability away to make the bus faster.

## A finding that produced a missing ADR

Part B failed on its first run, and not because of the bus:

```text
RESULT subtype: error_max_turns
num_turns: 2
structured_output: undefined
```

Structured output is delivered through an internal `StructuredOutput` end-turn
tool call. The first conclusion drawn from this was that the call always costs an
extra turn — **and that was an overgeneralisation from a single model**, caught by
the owner asking whether it was specific to `haiku`. It was.

| Model | `maxTurns: 1` | Assistant blocks |
|---|---|---|
| `haiku` | **fails** — `error_max_turns` | `thinking \| text`, then a second turn for `thinking \| tool_use:StructuredOutput` |
| `sonnet` | **succeeds** | `text \| tool_use:StructuredOutput` in one turn |

A weaker model answers in prose, ends its turn, and only then converts to the
schema. A stronger one does both at once. The clarification-request theory was
also tested and rejected: with an explicit "never ask for clarification" system
prompt, `haiku` still needed the second turn.

**The consequence is an interaction, not a setting.** The budget governor may
downgrade a model tier under pressure, so a turn budget tuned against `sonnet`
breaks silently when the same agent runs on `haiku` — and the symptom,
`error_max_turns`, names nothing about the cause.

A related trap, cheap to avoid: a vague prompt makes the model ask for
clarification, which burns the budget and produces the same symptom for an
entirely different reason. The two failures look identical from the outside.

**And a gap this exposed in the record.** The design puts structured output at
every model→kernel boundary — it is why the kernel can trust what a model returns
instead of parsing prose — but there was **no ADR for it**. Fourteen decisions
were written down and this one, which every other boundary depends on, was not.
Writing this report is what noticed. It is now
[ADR-0015](../adr/0015-structured-output-at-the-model-boundary.md), and the
turn-budget requirement lives there.

## Re-run on sonnet

Part A is model-independent by construction and reproduced exactly: four kills,
nothing lost, nothing torn, including the same 38-on-disk-against-37-acknowledged
result. Part B passed on `sonnet` with the structured payload intact and the bus
still costing about 1 ms.

## What it changes

- **Principle 2 holds on both filesystems.** Nothing acknowledged was lost under
  four kills per platform.
- **ADR-0014's rules are implemented and behave as written**, against a real store
  rather than in prose.
- **The bus is not a performance concern** — 1.1 ms against multi-second turns —
  so durability settings should be chosen for safety, not speed.
- **A hard requirement for the kernel**: turn budgets must include the structured
  output carrier turn.

## What this does **not** prove

- **`synchronous = FULL` was used deliberately.** Production will likely want
  `NORMAL`, which is sufficient for *process* crashes — the case actually tested
  here — but permits losing the last transaction on *power* loss. That is a
  separate decision, and it should be made explicitly rather than inherited.
- **The kill lands between an fsync and the acknowledgement, not inside one.**
  Durability against a kill landing mid-fsync is a kernel and hardware guarantee
  this project relies on rather than tests.
- **One writer.** The design mandates a single serialised writer, so contention
  was not exercised. It should be, once the kernel's writer queue exists.
- **`opus` was not probed**, deliberately. The model-comparison probes cost
  $0.12–$0.17 per turn on `haiku` and **$0.63 on `sonnet`**, against $0.0086 per
  `haiku` turn in [spike 0003](0003-concurrent-sessions.md). A 70× spread on the
  same model between two runs means the cost figures here describe these runs and
  nothing more. **The budget governor needs its own measurement**, against
  realistic prompts, before any of these numbers are treated as parameters.

## Reproducing it

```bash
cd spikes/0005-durable-bus
pnpm install
FREE_ONLY=1 pnpm start   # part A — the durability half, no AI usage
pnpm start               # everything
```
