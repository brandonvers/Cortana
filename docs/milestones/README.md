# Milestones

[RELEASING §2](../RELEASING.md) maps the build order onto versions and states the
rule that governs it: **no milestone starts before the previous one's definition
of done is met.** This directory holds each milestone's plan — what it builds, in
what order, and what it deliberately leaves alone.

A plan is written **before** the code and reviewed on its own. It is not a
retrospective and not a status page. When reality disagrees with a plan, the plan
is corrected in place and the correction says what changed.

| | Milestone | Plan |
|---|---|---|
| M1 | Kernel skeleton | [m1-kernel-skeleton.md](m1-kernel-skeleton.md) |
| M2 | Model runner port, audit, cost | [m2-model-runner.md](m2-model-runner.md) |
| M3 | Chat, conversation loop, approvals | [m3-conversation.md](m3-conversation.md) |
| M4 | [The roster: residents, delegation, report aggregation](m4-the-roster.md) | paused after step 4 |
| — | [First use: reachable from a phone](first-use.md) — between M4's steps 4 and 5 | in progress |
| M5 | Memory | not written — [blocked](../spikes/README.md#outstanding) |
| M6 | Scheduler, durable jobs, budget governor | not written |
| M7 | Dashboard, ops CLI, packaging | not written |

A plan carries a status, and it means the same four things every time:
**Proposed** while it is being argued about, **Accepted** once the decisions in
it are taken, **In progress** while the milestone is being built, and **Done**
when its definition of done is met — which is the gate the next milestone waits
on.

**A plan is not an [ADR](../adr/).** A decision that outlives its milestone — a
dependency, a boundary, a guarantee — belongs in an ADR, and the plan links to
it. The plan is the sequencing; the ADR is the commitment.
