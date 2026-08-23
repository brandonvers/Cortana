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
| M2 | Model runner port, audit, cost | not written |
| M3 | Chat, conversation loop, approvals | not written |
| M4 | Memory | not written — [blocked](../spikes/README.md#outstanding) |
| M5 | Scheduler, durable jobs, budget governor | not written |
| M6 | Dashboard, ops CLI, packaging | not written |

**A plan is not an [ADR](../adr/).** A decision that outlives its milestone — a
dependency, a boundary, a guarantee — belongs in an ADR, and the plan links to
it. The plan is the sequencing; the ADR is the commitment.
