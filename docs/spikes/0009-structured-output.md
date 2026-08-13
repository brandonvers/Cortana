# Spike 0009 — Structured output at the model boundary

**Date:** 2026-08-12 → 2026-08-13 · four runs
**Verdict:** ✅ **Closes an open question ADR-0015 could not explain**, and
**withdraws a finding this report had already drafted.**
**Decides:** a schema-authoring rule, and the cause of a cost spread the budget
governor could not have been designed around.

---

## The finding this report withdrew before publishing

An earlier draft led with *fabrication*: that a schema requiring a field the
model cannot truthfully supply makes it invent a value, producing a response that
is **schema-valid and false** — one that ADR-0015's Zod re-validation cannot
catch.

**That was wrong, and wrong by the exact mechanism it warned about.**

The detector was `/https?:\/\//` — a shape check — and its output was printed as
a truth verdict. Checked directly:

| value returned | what it actually is |
|---|---|
| `https://en.wikipedia.org/wiki/Boiling_point` | **HTTP 200**, and its summary is the boiling point of water — a correct, on-topic citation |
| `https://example.com` | the **RFC 2606 reserved** placeholder domain — the conventional way to say "no real source" |

Three observations, **zero fabrications**. Two are the model citing correctly and
one is it signalling absence in the only way the schema allowed.

Because the schema did not allow any other way. The required field was
`{ type: 'string' }` with no null — **absence was unrepresentable**, and the model
had no means to say it had no source. The same file's `deep-nesting` schema uses
`founded: { type: ['integer','null'] }`, so the escape hatch was understood and
simply not offered here. The probe was rigged, and then the model was blamed for
filling a field it could not leave empty.

Caught by adversarial review; the URL's status and RFC 2606 were then verified
directly rather than taken on report.

## What replaced it, measured

The arm that should have existed from the start: the same prompt, the same field,
`type: ['string','null']`, with a description saying null means no source.

```text
required sourceUrl  ->  https://en.wikipedia.org/wiki/Boiling_point
nullable sourceUrl  ->  null
```

**The remedy is one line in the schema, not a provenance layer.** The withdrawn
finding would have argued for building the expensive wrong thing.

### The behaviour that is real, in both directions

Across four adversarial schemas and four runs, nothing broke the mechanism, and
in every case **the schema rather than the content decided the response**:

| case | schema said | what happened |
|---|---|---|
| `closed-object` | one field, `additionalProperties: false` | true facts supplied in the prompt were **dropped** to fit |
| `unsupplied-field` | required, non-nullable | the field was **filled** because it could not be left empty |
| `unsupplied-field-nullable` | required, nullable | returned `null` |
| `impossible-enum` | `red \| green \| blue`, asked the colour of the number seven | returned `blue` |

**Schema shape wins over content fidelity, in both directions** — content is
dropped to fit the schema, and content is supplied to fill it. That is the
finding. It is not evidence of invention: *"what colour is the number seven"* has
no truth condition, so `blue` is not false, and the enum's order and membership
were never varied.

**Schema-validity is not truth-validity.** Zod re-validates shape, which is what
it is for and all it can do. A well-typed value asserting a fact about the world
is checked by nothing yet. Recorded as a design principle, not as a measured rate.

## ADR-0015's cost question, closed

The ADR parked this explicitly:

> A **70× spread** between two runs on the same model is not something to design a
> budget governor around until it is understood.

The instrument finally caught it in the act. The same case, twice, back to back,
in one run:

| | cost | output tokens | cache written | cache read |
|---|---|---|---|---|
| `deep-nesting` | **$0.0201** | 1,134 | **0** | 0 |
| `deep-nesting` repeated | **$0.6891** | 1,559 | **110,428** | 0 |

**34× the cost on 1.4× the output tokens, and the expensive turn wrote 110,428
tokens of prompt cache while the cheap one wrote none.**

That rules out the hypothesis this spike was built on. Silent structured-output
retries would bill as **output** tokens, and output tokens barely moved. The
cause is prompt-cache state, which [spike 0003](0003-concurrent-sessions.md)
already measured as a ~19× effect and which is now observed directly rather than
inferred.

Across all four runs the case falls into three regimes:

| cache activity | observed cost |
|---|---|
| none (0 written, 0 read) | $0.0201 – $0.0212 |
| ~107k **read** | $0.0735 – $0.0852 |
| ~110k **written** | **$0.6833 – $0.6891** |

**The consequence for the budget governor is the variance, not the mean.** An
identical call costs from two cents to sixty-nine, decided by whether that turn
happens to write the context cache. A governor that budgets from an average will
be wrong in both directions; it needs the cache-write case as its planning figure
or a way to know which regime it is in.

The five small cases show **zero cache activity of any kind** and cost a stable
$0.0014–$0.0054. So the schema itself is cheap and predictable: the swing belongs
to large-context turns, not to structured output.

One correction to the ADR's own framing while it is being amended: its "70×
between two runs on the same model" compares a `sonnet` figure with a `haiku`
baseline. The same-model spread it actually documents is smaller; the real
same-model spread, measured here, is **34×**.

## What could not be measured

**The retry-exhaustion path was never reached.** No adversarial schema produced
`error_max_structured_output_retries` in fifteen trials across four runs, on
`sonnet` only.

That is not evidence it is unreachable, and the coverage is thinner than it
looks: three of the four hard schemas are adversarial to *truth*, not to the
decoder. Only `deep-nesting` strains the mechanism structurally. And the failure
path is not entirely unobserved in this project — [spike 0005](0005-durable-bus.md)
recorded `structured_output: undefined` alongside `error_max_turns`, which is a
different exhaustion but the same absence at the kernel boundary.

## The `opus` row

`opus` completed the carrier turn at `maxTurns: 1`, returning structured output
in one turn like `sonnet`.

**n = 1**, on the `easy` one-field schema, a trivial prompt, `tools: []`, in the
run that was not instrumented. A **fails** cell is an existence claim and one
observation settles it; a **succeeds** cell is a universal claim and one
observation does not. No model has been measured at `maxTurns: 1` against a hard
schema.

## What this does **not** establish

- **That any model fabricates under schema pressure.** It was claimed, withdrawn,
  and never demonstrated. The one arm that made absence expressible returned
  `null`.
- **That the retry-exhaustion path works**, or is reachable at all.
- **Anything about `haiku` or `opus` beyond one carrier-turn observation.** One
  model family, one platform, one SDK version.
- **Why a turn writes the cache on one call and not the next.** The regimes are
  observed; what selects between them is not.
- **That the enum result generalises.** A question with no truth condition is not
  the same test as a field with one.

## Reproducing it

```bash
cd spikes/0009-structured-output
pnpm install
pnpm start                # sonnet, ~$0.10 unless a turn writes the cache
WITH_OPUS=1 pnpm start    # adds the opus carrier-turn observation
```

Cost is not predictable per run, for the reason the report is partly about.
