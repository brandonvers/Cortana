# M4 — the roster

**Status:** In progress — paused after step 4 on 2026-10-10, for [first use](first-use.md)
**Date:** 2026-09-05
**Version target:** `0.4.0`

---

## What M4 is

**Colleagues.** M3 gave you one agent that talks and forgets. This gives it a
team, and gives the kernel the machinery to run one: agents with their own
identity, delegation that is decided rather than assumed, and reports that
survive the process dying mid-delivery.

It is the milestone the plan was missing until M3 was written, and it is where
[CONCEPTS §3](../CONCEPTS.md) and §4 stop being description. Both of its spikes
are closed, which is unusual for a milestone this size and is worth saying
plainly: [0003](../spikes/0003-concurrent-sessions.md) measured that the hardware
holds a dozen sessions and that dormancy is close to free, and
[0005](../spikes/0005-durable-bus.md) measured ADR-0014's delivery rules, leases
and idempotency against a real store. **M4 promotes both out of the spikes
directory rather than discovering them.**

## Definition of done

> **Where it stands.** Steps 1 to 4 exist as packages — `@cortana/roster` and
> `@cortana/reports`, with their tests — and **nothing in the daemon uses them
> yet**: wiring them in is step 7. So no box below is ticked, including the ones
> whose package already does what the box says, because each box describes the
> running system, not a library.

- [ ] A roster you author as **files**, loaded and validated at boot, with a bad
      one naming the file and the field rather than failing at first use
- [ ] An agent is **dormant by default** and costs nothing until it is needed;
      waking one is measured against spike 0003's numbers rather than hoped for
- [ ] The main agent can **delegate**, and a delegation is decided by the policy
      engine like any other action — never by what an agent says about itself
- [ ] **Reports reach the kernel, not the main agent** ([ADR-0014](../adr/0014-kernel-mediated-reports.md)),
      and are durable **before** they are acknowledged
- [ ] The three delivery rules hold against the real store: a blocker goes
      immediately, siblings are delivered together, and a **stalled team cannot
      withhold what the others finished**
- [ ] A report survives `SIGKILL` mid-delivery, and one redelivered three times
      has effect **once**
- [ ] An **ephemeral worker** runs only under a profile that grants it, and its
      tool calls are decided by the same gate as everything else
- [ ] Every agent in the roster is contained by the allowlist
      [ADR-0021](../adr/0021-containment-is-an-allowlist-applied-to-every-call.md)
      established, and a roster entry that would widen it fails a test

## The packages

| Package | Owns | Depends on |
|---|---|---|
| `@cortana/roster` | Agent definitions, how they are loaded and validated, and the dormancy state machine | `core`, `config`, `policy`, `runner`, `storage` |
| `@cortana/reports` | Durable reports, leases, idempotency, and ADR-0014's delivery rules | `core`, `storage` |

Delegation itself goes in `@cortana/agent`, because it is a thing the main agent
does rather than a thing the roster is. `@cortana/reports` is separate from
`@cortana/roster` for the reason the audit is separate from the runner: **it is
correctness-critical and provider-free**, ADR-0014 says as much — "a bug here
silently loses work" — and code like that is easier to keep right when nothing
around it can distract from what it does.

## The order of work

**1. Definitions, and the roster that holds them.** Files parsed and validated,
the runtime state in the database, and the two kept apart. Nothing runs yet.

> Definitions are **markdown with TOML frontmatter**, fenced by `+++`, named by
> their filename. TOML because the configuration file already is one and
> `smol-toml` is already here — YAML would be a new dependency, in the package
> that parses files a module may ship, for a format whose implicit typing has a
> long history of reading a value as something other than what was written. The
> filename is the name because a name written twice drifts, and then one of them
> is wrong in a way nothing detects.

```markdown
+++
description = "Reads and triages the mailbox"
tier = "fast"
tools = ["Read"]
readable = ["/srv/mail"]
+++

You are the mail specialist. You are terse.
```

**2. Dormancy.** The state machine from
[ADR-0006](../adr/0006-dormancy-is-the-default.md), waking, the idle TTL, and a
test that a dormant agent holds no session. This is where spike 0003's numbers
become a property the repository checks.

**3. Reports, durably.** The store, the leases, the idempotency table. Spike
0005's kill test promoted the way spike 0005's *other* kill test already was in
M1 — the harness exists and its findings are what this step has to reproduce.

> **What the step found.** Four things in the spike's harness were right for a
> script and wrong for a daemon, and two of them were bugs a test now fails on:
> its lease could hand one report to two callers, and its reclaim made a
> restart wait out every dead lease's TTL. The idempotency table is gone — a
> report's own state is the record, so there is one row saying a thing once.
>
> **And the guarantee is at-least-once delivery, exactly-once completion.** A
> report handed to a model turn is an external effect, and a crash between the
> turn and the completion delivers it again after restart; nothing a store does
> can make that effect un-happen. **Step 4 and step 5 inherit this**: the main
> agent may see a report twice after a crash, reports carry their ids so a
> repeat is recognisable, and recognising it is the consumer's half of the
> bargain.

**4. Aggregation.** ADR-0014's three rules. The most correctness-critical code in
the milestone and the least visible when it is wrong.

> **What the step found.** Spike 0005's `readyFor` behaved as specified on the
> scenarios it was given and gave the wrong answer on four it was not: it
> **counted** reports, so an agent reporting twice filled the count while another
> team said nothing; it offered reports whose delivery was **in flight**; it
> measured what was missing against **undelivered** reports, so a late arrival
> counted already-delivered ones as missing; and it had **no decision requests**.
> Each one was put back as a mutation and each one fails a test.
>
> The first means step 3's `expected` count was the wrong model, and it was
> replaced by the list of who a request was given to — which is also the only
> way rule 3 can name *who* is missing, as the ADR requires.
>
> **And one case the ADR's wording did not cover: every team stalls.** "Deliver
> what is ready" with nothing ready delivers nothing, and the person who asked is
> never answered. The deadline notice now goes out even when empty, naming
> everyone, and is recorded so it goes out once.
>
> **Left for step 5:** a request whose assignee never reports stays open after
> its deadline notice, delivering stragglers as they come. When to give up on an
> assignee — its agent could not wake, or failed — is delegation's question.

**5. Delegation.** The main agent's `delegate` action, through the policy engine,
into the roster, out through the reports.

> **Paused here on 2026-10-10**, for [first use](first-use.md): two months in,
> the system had not been used once, and the questions this step has to answer
> are better answered by a week of real requests than by another plan. It
> resumes when first use is done, and starts by reading what that week found.

**6. Ephemeral workers.** `Task` behind the allowlist, for a resident whose
profile grants it.

**7. Assembly**, listed this time. M3's plan had six steps and needed a seventh,
and the lesson was that "the parts exist" and "you can use it" are different
claims. This one is on the list from the start.

## What the spikes already settle

| Finding | From | What it means here |
|---|---|---|
| A dozen sessions hold, at **264 MB each**, flat across scale | [0003](../spikes/0003-concurrent-sessions.md) | The roster size CONCEPTS asks for is affordable in memory. It is **not** affordable in tokens, which is what forces dormancy |
| Dormancy costs **−195 ms** on the realistic profile — waking is not slower than staying awake | [0003](../spikes/0003-concurrent-sessions.md) | The default costs nothing measurable. The sign was model-dependent across profiles, so this is a range rather than a promise |
| Zero acknowledged writes lost across four `SIGKILL`s; **38 on disk to 37 acknowledged** | [0005](../spikes/0005-durable-bus.md) | The guarantee is one-directional and this is the safe direction. A report that landed unacknowledged is retried; the idempotency table makes that harmless |
| Leases held by a dead process are reclaimed at boot | [0005](../spikes/0005-durable-bus.md) | Work does not strand when an agent's process dies mid-task |
| `applyOnce` gave `true, false, false` — one side effect from three deliveries | [0005](../spikes/0005-durable-bus.md) | Redelivery after a crash is **expected**, and this is the only thing that makes it safe |
| The three delivery rules behave as specified against a real store | [0005](../spikes/0005-durable-bus.md) | Including partial delivery naming what is missing rather than pretending to be complete |
| A subagent's tool calls reach the parent's decision, and the parent's deny rules propagate | [0011](../spikes/0011-quarantine-escape.md) | Ephemeral workers are contained by the resident that spawned them. Measured, not assumed |

## The decisions M4 could not avoid

Taken on **2026-09-05**, before any of it was written.

### 1. Files are the source; the database holds what runs

An agent **you** author lives in a file — markdown with frontmatter, in a
directory, in git. An agent the **system** created and promoted lives in the
database, along with every agent's runtime state.

The split is forced by two requirements that pull opposite ways. CONCEPTS §3.1
says promotion is "a state change rather than a rewrite", so something at runtime
must be able to add an agent; and a daemon that edits files in your directory is
a daemon that fights your editor and your git history. Putting authored agents in
the database instead would make an agent unreviewable, ungittable, and
unshippable by a pack — and §5 says a module contributes agents.

So the rule is **whoever wrote it, owns it.** The loader never writes to your
files, and the runtime never has to ask permission to remember something.

### 2. Debate is not in M4

[CONCEPTS §4.1](../CONCEPTS.md) makes debate an escalation from pipeline, and
[ADR-0004](../adr/0004-implement-coordination-ourselves.md) is where the
coordination layer is ours to build. Debate is the part of it that multiplies
cost by the number of participants, and spike 0009 measured a single identical
call ranging **34×** on cache state alone. Building a cost multiplier before
there is a roster to measure it against would be choosing the number first.

It is deferred, not dropped. The mechanism it needs — several agents addressing
each other rather than reporting upward — is exactly what
[ADR-0005](../adr/0005-hybrid-execution-topology.md) gives residents by making
them sessions rather than subagents, and that arrives in step 1.

### 3. An ephemeral worker exists only where a profile grants it

`Task` is a tool. ADR-0021 made the tool list an allowlist for a reason that
applies here without modification: a session gets nothing it was not given.

Spike 0011 measured that the containment holds through delegation — a subagent's
tool calls reach the parent's decision, and the parent's deny rules propagate to
it. That is the finding that makes this safe to enable at all, and it is why
enabling it is a line in a profile rather than a capability every resident has.

### 4. Delegation is kernel-mediated, and it is a policy decision

Not a new decision — ADR-0004 already puts the coordination layer here, and
ADR-0014 already routes reports through the kernel — but M4 is the first
milestone that could quietly do otherwise, by letting the main agent spawn
residents as subagents and skipping all of it.

It cannot: ADR-0005 makes residents sessions precisely so they have identity and
can address each other. And **a delegation is a `ToolRequest` like any other**,
so it is decided by `@cortana/policy` before it happens. An agent that could
delegate its way around its own profile would have a profile that means nothing.

## What M4 does not build

| Not in M4 | Where |
|---|---|
| Debate mode | Deferred; see above |
| Memory of any kind — agents still forget between sessions | M5, [blocked on a corpus](../spikes/README.md#outstanding) |
| The scheduler, and anything that speaks first | M6 |
| The budget governor, which is what makes a roster affordable in practice | M6 |
| The module host, and modules contributing agents | M7 |
| A dashboard showing what the team is doing | M7 |

**The sharpest limit is the same one M3 had, and it is worse here**: a roster of
specialists that forget everything between jobs is a roster of strangers. M4
makes them exist and work; M5 is what makes them colleagues. That ordering is
forced — M5 is blocked on a corpus only the owner can produce — and it is worth
knowing while using M4 rather than discovering afterwards.

## Risks

- **Aggregation is where work goes missing silently.** ADR-0014 says it in as
  many words. Spike 0005 measured the rules behaving correctly in a harness; the
  risk is the promotion, not the design, and the kill test is the thing that
  keeps it honest.
- **A roster is a cost multiplier before it is a capability.** Every awake
  resident spends tokens, and the budget governor that answers for it is M6.
  Until then the only defence is dormancy and a small roster, and an operator who
  wakes eight agents will find out what that costs from their own account.
- **Delegation is a new way for a profile to be wrong.** An agent that can
  delegate to one with a wider profile has, in effect, that wider profile. This
  is the containment question M4 introduces.

  > **Decided on 2026-10-20, by the owner: intersected.** A delegate works under
  > the intersection of its own profile and its delegator's, so delegating never
  > reaches past what the delegator could do itself. The cost is accepted: a
  > task the delegator was not entitled to stalls rather than proceeds, and the
  > stall goes up to the main agent, which decides — the same place any other
  > blocker goes under ADR-0014. Step 5 implements this rather than choosing it,
  > and a delegation that would widen a profile fails a test.
- **The definition file format is an interface** the moment anybody writes one.
  Changing it later costs whatever people have written, so it is worth being
  narrow on the first pass and adding fields rather than removing them.
