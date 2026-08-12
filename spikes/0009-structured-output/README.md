# Spike 0009 — Is structured output enforced, and what does the kernel see when it is not?

**⚠️ This spike consumes AI usage.** Roughly 10 turns on `sonnet` by default;
`opus` is opt-in behind `WITH_OPUS=1`. The harness prints what it actually spent.

[ADR-0015](../../docs/adr/0015-structured-output-at-the-model-boundary.md) requires
a schema at every model→kernel crossing and says the kernel re-validates with Zod
anyway, because *"the provider's enforcement is a strong prior, not a guarantee."*
That decision is already conservative, so this spike is not asking whether to
validate. It is asking **what the error path actually looks like**, because
ADR-0015 also says a failed response is *"a handled error path, not an
exception"* — and nothing has ever exercised it.

## What reading the SDK changed before this ran

The typings answer part of the question outright, and raise a better one:

```ts
subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd'
       | 'error_max_structured_output_retries'
TerminalReason: … | 'structured_output_retry_exhausted'
structured_output?: unknown
```

So structured output is **not best-effort**: it is enforced with internal
retries, and there is a named exhaustion state. The retry count is not
configurable, and the delivered value is typed `unknown` — the SDK does not check
it either.

That produces a hypothesis about something ADR-0015 flagged and could not
explain:

> Probing this produced turn costs of $0.12–$0.17 on `haiku` and **$0.63 on
> `sonnet`** for a trivial prompt, against $0.0086 per `haiku` turn measured in
> spike 0003. A **70× spread** between two runs on the same model is not
> something to design a budget governor around until it is understood.

**Silent structured-output retries would explain that spread.** `modelUsage` is
documented as covering "every model call made through the query pipeline …
including internal calls", so if retries happen they are visible there even
though nothing reports them. Criterion 5 tests it.

## Pass criteria, stated before running

| # | Criterion | Threshold |
|---|---|---|
| 0 | An easy schema returns valid structured output | the mechanism works at all |
| 1 | **The schema is doing the work** | the same prompt **without** a schema returns a different shape — otherwise compliance proves nothing |
| 2 | **The failure path is reachable** | an adversarial schema produces `error_max_structured_output_retries`, **or** it is demonstrated unreachable and that is the finding |
| 3 | What the kernel receives on failure | recorded: is `structured_output` absent, partial, or malformed? |
| 4 | **A hard schema costs more than an easy one** | tests the silent-retry hypothesis against ADR-0015's 70× spread |
| 5 | **Fabrication** — a required field the content cannot supply | recorded, not scored: does the model invent a value? |
| 6 | `opus` carrier-turn behaviour at `maxTurns: 1` | fills the row ADR-0015 left empty |

**Criterion 1 exists because compliance is not evidence.** A model asked a simple
question may return a well-shaped object whether or not a schema was enforced. The
no-schema control is what separates "the schema constrained it" from "the answer
happened to look like that" — the same move
[spike 0007](../../docs/spikes/0007-lexical-routing.md) needed and did not have.

**Criterion 5 is the one with consequences for the kernel.** If the model
fabricates a value rather than failing, the response is **schema-valid and
false**, and ADR-0015's Zod re-validation cannot catch it — shape checking passes
on a well-typed lie. That would mean certain fields need semantic checks or a
provenance rule, not just a type. It is recorded rather than scored because there
is no honest pass mark for it in advance.

## The adversarial schemas

Each is designed to make compliance genuinely hard, in a different way.

| Case | Schema | What it strains |
|---|---|---|
| `easy` | `{ answer: string }` | the control — nothing is hard |
| `impossible-enum` | `{ colour: enum[red,green,blue] }`, asked about something with no colour | no valid value exists |
| `unsupplied-field` | `{ answer: string, sourceUrl: string(uri) }`, with no source available | **fabrication**: the field is required and the content cannot supply it |
| `closed-object` | `additionalProperties: false`, with the prompt containing extra facts worth reporting | the temptation to add a field |
| `deep-nesting` | four levels, mixed arrays and unions, all required | structural difficulty rather than semantic |

## Cost

`sonnet` turns on a trivial prompt have been measured at $0.0086 to $0.63 in this
project — the spread this spike exists partly to explain. Budget accordingly: the
harness carries a model-aware `maxBudgetUsd` ceiling and prints per-case cost and
`modelUsage` so the numbers are attributable rather than aggregate.

`opus` is behind `WITH_OPUS=1` because it is a multiple of `sonnet` and only
criterion 6 needs it.

## Running it

```bash
cd spikes/0009-structured-output
pnpm install
pnpm start                # sonnet
WITH_OPUS=1 pnpm start    # adds the opus carrier-turn row
```

Claude Code must be installed and logged in. The harness never handles
credentials.
