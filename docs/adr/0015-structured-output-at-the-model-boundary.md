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
| `opus` | **succeeds** — n=1, trivial prompt | `text \| tool_use:StructuredOutput` in one turn |

> **The rows are observations, not guarantees.** Each was measured against a
> one-field schema on a trivial prompt, on Claude Code 2.1.226 / Agent SDK
> 0.3.226. `haiku` and `sonnet` come from
> [spike 0005](../spikes/0005-durable-bus.md)'s harness, `opus` from
> [spike 0009](../spikes/0009-structured-output.md) — a different probe, n=1.
>
> A **fails** cell is an existence claim and one observation settles it. A
> **succeeds** cell is a universal claim and one observation does not: it records
> that the carrier *can* fit in one turn, never that it always will. **No model
> has been measured at `maxTurns: 1` against a hard schema.** The budget therefore
> stays carrier-plus-headroom for every model including `opus`; nothing here
> sanctions a `maxTurns: 1` configuration. The rows name tier aliases, which
> resolve to snapshots that change underneath this record.

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
- **A cost spread that is now explained — and it is not structured output's
  fault.** This ADR previously recorded turn costs of $0.12–$0.17 on `haiku` and
  $0.63 on `sonnet` as an unexplained "70× spread" and refused to let a budget
  governor be designed around it. Two corrections, from
  [spike 0009](../spikes/0009-structured-output.md).

  The 70× compared a `sonnet` figure against a `haiku` baseline. The real
  same-model spread, measured on one identical call repeated back to back, is
  **34×** — $0.0201 against $0.6891.

  The cause is **prompt-cache state, not structured output**. The expensive turn
  wrote 110,428 tokens of cache and the cheap one wrote none, while output tokens
  differed by 1.4×. Silent structured-output retries would bill as output tokens,
  so they are ruled out. Three regimes were observed: no cache activity ≈ $0.02,
  ~107k cache **read** ≈ $0.08, ~110k cache **written** ≈ $0.69.

  **What this hands the budget governor is the variance, not a number.** An
  identical call costs from two cents to sixty-nine depending on whether that turn
  writes the context cache, and what selects between the regimes is not known.
  Small structured calls are unaffected: they show zero cache activity and cost a
  stable $0.0014–$0.0054, so the schema itself is cheap and predictable.
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

## Schema-validity is not truth-validity

Added after [spike 0009](../spikes/0009-structured-output.md), as a design
principle rather than a measured rate.

The Zod re-validation above checks **shape**, which is what it is for and all it
can do. A well-typed value that asserts a fact about the world — a source, an
identifier, a reference, a citation — is checked by nothing yet.

Spike 0009 put four adversarial schemas against `sonnet` and none broke the
mechanism; in every case **the schema rather than the content decided the
response**, in both directions. A closed object dropped true facts supplied in the
prompt in order to fit its single field. A required non-nullable field was filled
because it could not be left empty.

**The cheap remedy was measured and works: make absence representable.** The same
prompt and field with `type: ['string','null']` returned `null` where the
non-nullable version returned a value. So:

- A schema field that can legitimately have no value **must permit null**, and say
  so in its description. Requiring what the content may not contain is an
  authoring error, not a model failure.
- Fields that assert facts about the world need a semantic or provenance check
  **only where the null option does not suffice**. Which fields those are is
  unmeasured, and a provenance layer should not be built before one is found.

An earlier draft of that spike claimed the opposite — that models fabricate under
schema pressure — on the strength of a regex that tested URL *shape* and printed
the result as a truth verdict. The flagged URL resolved and was on topic. The
claim was withdrawn before it reached this ADR, and the episode is recorded here
because the wrong version would have justified building the provenance layer the
right version says to defer.

## Revisit when

A measurement shows the carrier turn is a material share of usage in practice, or
the runner gains a way to return structured data without spending a turn, or a
field is found where making absence representable is not enough.
