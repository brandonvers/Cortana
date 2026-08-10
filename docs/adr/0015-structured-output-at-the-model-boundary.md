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

### Turn budgets must include the carrier turn

Structured output is delivered through an internal end-turn tool call, and **that
call counts as a turn**. With `maxTurns: 1` the model answers in text and is cut
off before it can return the schema, producing `error_max_turns` and no structured
output at all.

Measured in [spike 0005](../spikes/0005-durable-bus.md). Every turn budget the
kernel sets must allow for it, and the failure is quiet: a budget that looks
generous is in fact zero.

## Consequences

- The kernel's decisions rest on validated values, and a malformed response
  surfaces as a validation failure at the boundary rather than as strange
  behaviour three layers in.
- Schemas are shared artefacts: one Zod schema produces both the JSON schema sent
  to the model and the static type used in the kernel.
- **A cost**: structured output spends a turn, and turns are the unit the provider
  meters. Every gated decision is measurably more expensive than a free-text
  answer would be. Accepted — an unparseable decision is more expensive still.
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
