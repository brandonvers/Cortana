# M2 — the model runner, audit, and cost

**Status:** Accepted — not started
**Date:** 2026-09-01
**Version target:** `0.2.0`

---

## What M2 is

The first code in this repository that talks to a model, and therefore the first
test of whether [ADR-0001](../adr/0001-model-access-behind-a-port.md)'s port is
real or aspirational. That ADR is the project's mitigation for a policy risk it
does not control — the provider's position on third-party harnesses moved twice
in five months — and the mitigation is only worth something if a second adapter
could actually be written.

So the measure of success here is not that agents run. It is that **the port is
shaped by what any adapter could do**, and that a second one exists to prove it
rather than to be promised.

Two things arrive with it, because a turn that nobody recorded is a turn nobody
can explain: the **audit pipeline**, and **cost**, which the spikes have already
made more interesting than "add up the numbers".

## Definition of done

- [ ] A session can be started, given a turn, and stopped through the port, and
      **no package outside `@cortana/runner-claude` imports a provider type** —
      already enforced by `check:boundaries`, which has had nothing to catch
      until now
- [ ] **One contract suite passes against both adapters.** The port is real when
      the same tests hold for the real one and a second one; until then it is a
      description of the first
- [ ] Structured output is requested with a schema and **re-validated with Zod**;
      a response that fails is a handled error path, never coerced into looking
      valid ([ADR-0015](../adr/0015-structured-output-at-the-model-boundary.md))
- [ ] **Turn budgets are derived from the model in use**, with headroom for the
      carrier turn, and a model change recomputes them rather than inheriting
- [ ] **Every turn is durably recorded before its result reaches the caller**, and
      the prompt, tool calls, result and cost share one identifier
- [ ] Cost is recorded **as reported, with the cache counters that explain it**,
      and nothing in the interface presents a per-turn figure as stable
- [ ] The account usage meter is readable, and **its absence is a normal state**
      rather than an error
- [ ] A session that dies is not a kernel that dies: a crashed or unresponsive
      session is contained, recorded, and restartable

## The packages

```text
             ┌──────────┐
             │   core   │
             └────┬─────┘
                  ▼
            ┌───────────┐        the port, and a second adapter
            │  runner   │        at @cortana/runner/testing
            └─────┬─────┘
        ┌─────────┴──────────┐
        ▼                    ▼
┌───────────────┐     ┌─────────────┐
│ runner-claude │     │   audit     │
│ the only      │     │ what a turn │
│ package that  │     │ did, durably│
│ may import    │     └─────────────┘
│ provider types│
└───────────────┘
```

| Package | Owns | Depends on |
|---|---|---|
| `@cortana/runner` | The `ModelRunner` port, its value types, and the contract suite every adapter must pass. **No provider anything** | `core` |
| `@cortana/runner/testing` | A deterministic second adapter. Not a convenience — the thing that makes the port a port | `core` |
| `@cortana/runner-claude` | The adapter. The **only** package permitted to import `@anthropic-ai/claude-agent-sdk`, by a rule CI has enforced since M1 step 0 | `core`, `runner`, `config` |
| `@cortana/audit` | The record of what every turn did, written through M1's writer | `core`, `storage`, `bus`, `runner` |

### Why the fake adapter is not a test double

`@cortana/core/testing` holds a manual clock and a recording logger, and those
are conveniences. This one is different in kind. ADR-0001 says a second adapter
is expected "for deterministic tests if nothing else" and that "contract tests
against recorded fixtures make the port real rather than aspirational" — which is
a claim about the **port's design**, not about test coverage. A port with one
implementation is a description of that implementation wearing an interface.

So it is written **first**, along with the contract suite, and the real adapter is
built to pass tests that already exist. That ordering is the point: a port
designed after its only implementation inherits every assumption the
implementation made.

## The order of work

Each numbered step is one pull request and ends with `main` green.

**1. The port, the fake, and the contract suite — in that order, before any
provider code.** Writing the adapter first would let the SDK's shape leak into
the port through nothing more than convenience.

**2. `runner-claude`, until it passes the suite unchanged.** Any test that has to
be relaxed for the real adapter is a finding about the port, and gets recorded as
one rather than accommodated quietly.

> **This happened, before a line of the adapter was written.** Reading the
> provider's own interface showed that the output format is a parameter of the
> call that opens a session, with no control method to change it and no
> per-message field carrying one: a session is prose or structured for its whole
> life. The port had put both on one session, which is the obvious design and not
> one every adapter can implement, so the port changed rather than the adapter
> working around it. What that leaves open — an agent needing both would now need
> two sessions, at 263 MB each — is recorded in `packages/runner/src/port.ts` for
> M3 to answer, not guessed at here.

**3. Structured output and turn budgets.** ADR-0015 already carries the measured
requirement, including the one that has teeth: a budget tuned against `sonnet`
**breaks silently when the same agent is downgraded to `haiku`**, and the symptom
— `error_max_turns` — names nothing about the cause.

> **This closed with steps 1 and 2 rather than becoming work of its own**, and the
> reason is worth keeping. The port gives a caller nowhere to pass a turn budget,
> and the adapter imposes none either — it leaves `maxTurns` unset, so the
> provider decides when a turn is finished. That *is* ADR-0015's requirement:
> deriving the budget from the model in use, by asking the thing that knows.
> Verified against the case the ADR names as the failure — `fast` tier, which
> maps to the model that needs a second turn for the carrier — where a structured
> answer came back in 4.6 s with no budget set by anyone.
>
> The runaway a turn limit was standing in for is bounded by **cost** instead:
> the adapter takes a `maxBudgetUsd` ceiling the provider enforces. A turn count
> is a proxy that breaks per model; money is the thing that actually matters.
> What the ceiling should default to is M5's question, not this one's.

**4. Audit.** Schema, the write path through M1's writer, and correlation. This is
the step where "durable before acknowledged" gets its second user.

**5. Cost and usage.** Recording what was reported, and reading the account meter
without approaching it.

## What the spikes already settle

M2 does not get to rediscover any of this, and two of them constrain the
interface rather than merely informing it.

| Question | Settled by | What it hands M2 |
|---|---|---|
| Is session-per-resident affordable? | [0003](../spikes/0003-concurrent-sessions.md) | 263–264 MB per idle session, flat across scale. The port must make sessions explicit, because they are the expensive object |
| Does dormancy cost anything? | [0003](../spikes/0003-concurrent-sessions.md) | −195 ms on the realistic profile; **the sign is not fixed** and depends on the model. Waking is not a cost the port should hide |
| Can a turn's cost be attributed? | [0009](../spikes/0009-structured-output.md) | **No, not stably.** One identical call, repeated, cost $0.0201 and $0.6891 — 34× — on prompt-cache state alone. Three regimes, and what selects between them is unknown |
| Is structured output free? | [0009](../spikes/0009-structured-output.md), [0005](../spikes/0005-durable-bus.md) | Small structured calls are cheap and stable ($0.0014–$0.0054). The carrier turn is not free on every model |
| Can the governor see the limit? | [0013](../spikes/0013-usage-headroom.md) | Per-window utilization, reset times, and a pushed warning. **Account-wide, not per session.** Two APIs on different scales — `87` and `0.87` |
| Does a schema make an answer true? | [0009](../spikes/0009-structured-output.md) | No. The schema decided the response in both directions; a field that may have no value **must permit null** |

## The decisions M2 could not avoid

All four were taken on **2026-09-01**. One of them outlives the milestone and is
an ADR; the rest are sequencing and stay here.

### 1. The port speaks in sessions, not turns

[ADR-0005](../adr/0005-hybrid-execution-topology.md) gives every resident a
long-lived session and spike 0003 priced one at 263 MB. A port offering only "run
a turn" would hide session lifetime somewhere, and the thing hidden would be the
most expensive object in the system. So: `start`, `turn`, `stop`, with the session
as a value the kernel holds. Any adapter can keep conversation state, even one
whose provider does not.

**A related finding, which shrinks the port rather than growing it.** ADR-0005
runs ephemeral workers as subagents, and [ADR-0004](../adr/0004-own-the-orchestration-layer.md)
deliberately adopted that upstream capability — so subagents look like they belong
in the port, and they would be the hardest thing for a second adapter to provide.
They do not belong in it. A resident's *session* spawns them, through its own tool
surface, when the model decides to; the kernel never asks for one. **The port needs
no verb for subagents**, only a flag on a session saying whether that tool surface
is enabled.

### 2. Tables live with their owner; migrations stay central

M1 put every table in `@cortana/storage` because M1 had one. From here each
package declares its own, `drizzle.config.ts` collects them, and there is still
**one ordered migration history** — which is the property
[ADR-0010](../adr/0010-sqlite-storage.md) actually cares about: one database file,
one transaction, one backup, one recovery story.

What this buys is that M4 and M5 are additions rather than edits to a file
everyone shares, and that `@cortana/audit` owns its own shape. What it costs is
that the schema is no longer readable in one place, which is a real loss and the
reason the alternative was close.

### 3. The audit stores prompts in full, with a retention window

Recorded as [ADR-0019](../adr/0019-the-audit-stores-what-was-said.md), because what
is on the disk is a guarantee rather than a sequencing choice.

Truncating produces a trail that cannot explain a single decision, which is the
whole purpose. The consequences are stated rather than discovered: the database
contains the transcript, so does every backup of it, and `Secret` cannot help —
it keeps a credential out of a log line, and a prompt is not a log line but what
the operator typed.

Retention defaults to 90 days. "Forever" stays available and has to be written
down, because unbounded retention is not a decision to keep everything; it is a
decision to defer deletion to the day the disk fills.

### 4. Two second adapters, with different jobs — and CI never calls the provider

The hand-written fake is the second adapter: deterministic, free, and it runs
everywhere including CI, which has no provider credential and is not going to be
given one — ADR-0001's whole shape is that this project never handles anyone's
provider credentials, and that applies to its own build as much as to a user.
Alongside it, a small set of **recorded fixtures**, each marked with the version
it was captured against, covers the parsing the fake cannot: a fixture that
silently describes an old release is worse than no fixture.

**Runs against the real adapter are started by hand.** Spike 0009 measured one
identical call costing $0.0201 and $0.6891, so a suite that called the provider
on every pull request would have a bill that scaled with the test count and
varied 34× for reasons nobody controls. This belongs in `CONTRIBUTING.md` when
the code exists.

## What M2 does not build

| Not in M2 | Where |
|---|---|
| The conversation loop, chat, approvals, the policy engine | M3 |
| Report aggregation and delivery ([ADR-0014](../adr/0014-kernel-mediated-reports.md)) | M3 |
| Memory, embeddings, retrieval | M4 |
| **The budget governor.** M2 makes the meter readable; deciding what to do about it is M5 | M5 |
| The scheduler and the proactive gate | M5 |
| Dashboard, ops CLI, packaging | M6 |
| Quarantine of untrusted content ([ADR-0007](../adr/0007-quarantine-untrusted-content.md)) | M3 — it needs a conversation to quarantine |

## Dependencies

None known beyond what M1 already installs. The provider SDK arrives in
`runner-claude`, at the version the spikes last verified, and is checked afresh
before it is added — spikes 0010 to 0013 ran against Claude Code **2.1.229** and
Agent SDK **0.3.229**, which will not be current by the time this is written.

`zod` is already present and is what ADR-0015 requires at this boundary.

## Risks

- **The port is the deliverable, and it is the thing most easily got wrong.** A
  port that fits one SDK is not a port. The contract suite and the fake are the
  only defences, which is why they come first.
- **A provider SDK version bump can invalidate a measurement.** Everything the
  spikes established was measured against a specific version, and the ones that
  matter most here — the carrier turn, the cost regimes, the usage endpoint's
  shape — are the ones most likely to move. The usage endpoint is named
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` and means it.
- **The audit is a correctness-critical write path.** ADR-0014 says aggregation
  belongs "in the tested-thoroughly category alongside the queue and the policy
  engine"; the audit sits on the same footing, because a record that is missing is
  indistinguishable from a thing that never happened.
- **This milestone spends money.** Every test against the real adapter is a
  charged turn on the maintainer's subscription, and spike 0009 measured that an
  identical call can cost 34× what it cost last time. The contract suite running
  against the fake is not only a design device; it is what keeps the bill from
  scaling with the test count.
