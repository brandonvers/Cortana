# 0015. Structured output at every model→kernel boundary

**Status:** Accepted
**Date:** 2026-08-10

## Context

The kernel has to act on what a model returns: deliver a message or hold it,
promote an agent or discard it, interrupt the user or stay silent. Every one of
those is a decision made from model output, and the kernel needs that output to
be a value it can check rather than prose it has to interpret.

Parsing prose is the failure mode this project cannot afford. It works in testing,
degrades silently as prompts drift, and fails in ways that look like the model
being wrong rather than the boundary being untyped.

This decision was implicit in the design from the beginning — the proactive gate
in the product brief is specified as a schema, and
[ADR-0014](0014-kernel-mediated-reports.md) assumes typed reports. It was never
written down, which a spike report noticed before the code did.

## Decision

**Every crossing from a model back into the kernel carries a schema.**

- The model is given a JSON schema through the runner's structured-output
  facility, so the shape is enforced at the provider rather than requested in
  prose.
- **The kernel re-validates with Zod anyway.** The provider's enforcement is a
  strong prior, not a guarantee, and the kernel's own types are the boundary that
  matters.
- A response that fails validation is a **handled error path**, not an exception:
  retried, escalated, or recorded as a failed turn. It is never coerced into
  looking valid.
- Free text remains what it should be — the content of a message to the user —
  never the carrier of a decision.

### Turn budgets must allow for the carrier turn, and the cost is model-dependent

Structured output is delivered through an internal `StructuredOutput` end-turn
tool call. **Whether that call fits in the same turn as the model's answer
depends on the model**, which was measured rather than assumed:

| Model | `maxTurns: 1` | Assistant blocks |
|---|---|---|
| `haiku` | **fails** — `error_max_turns`, no schema | `thinking \| text` then, on a second turn, `thinking \| tool_use:StructuredOutput` |
| `sonnet` | **succeeds** | `text \| tool_use:StructuredOutput` in one turn |
| `opus` | not measured — see the cost note below | — |

A weaker model answers in prose, ends its turn, and only then converts to the
schema. A stronger one does both at once.

**The consequence is an interaction, not just a setting.** The main agent assigns
models per agent, and the budget governor may downgrade a model tier under
pressure. A turn budget tuned against `sonnet` therefore **breaks silently when
the same agent is downgraded to `haiku`** — the agent stops returning structured
output, and the symptom is `error_max_turns` rather than anything naming the
cause.

So the rule is not a number. **A turn budget must be derived from the model in
use, with headroom for the carrier**, and a model change must recompute it rather
than inherit it.

Measured in [spike 0005](../spikes/0005-durable-bus.md).

## Consequences

- The kernel's decisions rest on validated values, and a malformed response
  surfaces as a validation failure at the boundary rather than as strange
  behaviour three layers in.
- Schemas are shared artefacts: one Zod schema produces both the JSON schema sent
  to the model and the static type used in the kernel.
- **A cost**: on a model that needs a second turn for the carrier, every gated
  decision costs an extra round trip. Accepted — an unparseable decision costs
  more.
- **A cost worth measuring separately.** Probing this produced turn costs of
  $0.12–$0.17 on `haiku` and **$0.63 on `sonnet`** for a trivial prompt, against
  $0.0086 per `haiku` turn measured in
  [spike 0003](../spikes/0003-concurrent-sessions.md). A 70× spread between two
  runs on the same model is not something to design a budget governor around
  until it is understood. It is recorded here as an open question rather than a
  parameter, and `opus` was deliberately not probed.
- **A constraint on prompts**: a vague instruction makes the model ask for
  clarification instead of answering, which consumes the same budget and produces
  the *same symptom* as the carrier-turn problem. Two distinct causes, identical
  from the outside, so both belong in the runbook.
- Schema changes become interface changes, versioned and migrated like any other.

## Alternatives considered

**Parse free text with a tolerant parser.** No extra turn, no schema plumbing.
Rejected: it fails silently and progressively, which is the worst available
failure mode for a system that decides whether to interrupt someone or send mail
on their behalf.

**Trust the provider's enforcement and skip Zod.** Rejected on the project's
standing rule that a property enforced once is not enforced. The re-validation is
cheap and it is the layer we control.

**Ask for JSON in the prompt without a schema.** Rejected: that is parsing prose
with extra steps, and it puts a correctness property in prompt text — which this
project does not permit anywhere.

## Revisit when

A measurement shows the carrier turn is a material share of usage in practice, or
the runner gains a way to return structured data without spending a turn.
