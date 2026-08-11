# Spike 0007 — Is the lexical index a specialist or a voter?

**Date:** 2026-08-11 · four runs
**Verdict:** ❌ **Failed its own pre-registered criterion, and does not answer its
question.** No design change follows from it.
**Decides:** nothing. What it establishes is what a fifth attempt would have to
do differently.

---

## The stop condition fired, and this report leads with it

Criterion 2 was written before the spike ran, named in three files as the
load-bearing one, and its consequence was spelled out in advance:

> **Pure vector search FAILS on exact-match queries** — recall@1 **< 60%**.
> …If pure vector search handles exact identifiers fine, then the lexical indexes
> have no specialist role either, and the honest answer to ADR-0010 is to delete
> them rather than to reposition them.

It measured **75.0%**. The harness records `FAIL` and exits non-zero.

The conclusion this spike was drafting — *reposition the lexical index as a
confidence-gated specialist* — is the branch that outcome excludes. Publishing it
anyway would have meant re-reading the exact number that failed the criterion
(75.0%) as the evidence for a trend, which is the over-reading this project has
twice refused. So it is not published.

## What was measured

| | |
|---|---|
| Environment | Debian, Xeon E5-2695 v2 × 48, Node 24.19.0, SQLite 3.53.4, sqlite-vec 0.1.9 |
| Model | `bge-m3`, 1024 dims, local Ollama, **CPU** |
| Dataset | 16 exact items in 8 near-duplicate pairs, 12 semantic items from spike 0006 |
| Queries | 12 exact, 12 semantic |
| Corpus | padded to 100 / 300 / 1000 with generated distractors |

```text
exact-match recall@1 as the corpus grows
strategy                  28    100    300   1000
vector                100.0%  91.7%  75.0%  75.0%
rrf-staged             91.7%  91.7%  91.7%  91.7%
router-shape           91.7%  91.7%  83.3%  83.3%
router-confidence     100.0% 100.0%  91.7%  91.7%
lexical alone          91.7%  91.7%  91.7%  91.7%

at 1000 items          all MRR   exact@1  exact MRR   sem MRR
router-confidence        0.958     91.7%      0.917     1.000
router-both              0.958     91.7%      0.917     1.000
rrf-staged               0.935     91.7%      0.938     0.933
vector                   0.889     75.0%      0.778     1.000
rrf-weighted-0.1..0.9    0.862–0.889
```

This table was read as *"vector search degrades with scale, lexical does not, and
a confidence-gated router beats both."* An adversarial review of that reading —
eight agents over three independent audits and six refutation attempts — found
four defects, each of which was then verified directly. All four hold.

## Defect 1 — the mechanism arrives after the effect it is supposed to explain

The claim was that vector search degrades because the corpus fills with
identifiers one digit from the target. Checking when that crowding actually
happens:

| corpus | invoice distractors | range | **within ±10 of target `2026/0847`** |
|---|---|---|---|
| 28 | 0 | — | **0** |
| 100 | 9 | `0800–0808` | **0** |
| 300 | 35 | `0800–0834` | **0** |
| 1000 | 121 | `0800–0922` | **20** |

The distractor ranges **ascend from a floor** rather than surrounding the target.

So the entire drop — 91.7% → 75.0%, between 100 and 300 — happens while the
target has **no near neighbours at all**. And between 300 and 1000, where twenty
of them finally arrive, vector recall@1 moves **exactly zero points**.

**The proposed cause is absent where the effect occurs and present where it does
not.** Whatever moved those two queries, it was not crowding.

## Defect 2 — "lexical is scale-independent" is a property of the generator

`distractors()` seeds a `taken` set with every real identifier, so no generated
item can ever carry a token a query names. Every queried identifier is therefore
a **hapax** — globally unique at every corpus size, by construction.

BM25 on a term that appears exactly once cannot degrade as the corpus grows. The
flat 91.7% across four sizes is **one measurement reported four times**, not
evidence of robustness.

Real memory violates this constantly: the same invoice number appears on the
invoice, the payment and the reminder. That case is excluded by construction, and
it is the case where lexical retrieval actually has to discriminate.

## Defect 3 — the winner changes two things at once

```ts
'rrf-staged':        rrf([rrf([lex, tri]), vec])   // uses the trigram index
'router-confidence': rrf([lex, vec])               // does NOT use it
```

`router-confidence` and `router-both` are the **only** arms that skip the trigram
list. So the table cannot separate *"the confidence gate helps"* from *"dropping
the trigram index helps"* — both explanations fit it equally.

The one comparison that does hold inputs fixed while varying only the gate runs
the **wrong way**: `rrf-staged` 91.7% against `router-shape` 83.3% on the exact
half.

There was no `rrf([lex, vec])` control and no gated `rrf(rrf(lex,tri), vec)` arm.
The experiment needed both and had neither.

## Defect 4 — one query in twelve has 120 valid answers

`Mi Nagy Erika telefonszáma?` expects item 11. At 1000 items the corpus contains
**120 distractors that also say "Nagy Erika"**, each with a different number,
because the phone template reused the name. One twelfth of the exact half is
mislabelled rather than hard.

## Smaller, and still disqualifying

- **`CONFIDENCE_MARGIN = 1.5` was never swept** — invented, untuned, and
  load-bearing for the recommendation. In a file whose own comment calls
  hard-coding a single constant "the kind of drift that made spike 0006's first
  run worthless". A sweep has since been added to the harness and has not run.
- **Nothing in the table is statistically resolvable.** Twelve exact queries: one
  query is 8.3 points. The whole curve is three query-flips, on one deterministic
  corpus, with no repeats and no intervals.
- **"Routing costs 0.018 ms"** excludes both FTS5 lookups, which run before any
  strategy and without which the bm25 signal does not exist. It is an average over
  eleven strategies, several of which do nothing.
- **Corpus growth was never controlled.** All 972 distractors are `half: 'exact'`;
  the semantic half stays 12 items and 1.000 at every size. The run's own control
  shows growth alone does not degrade vector retrieval.

## The misattribution, which is a repeat

This spike, and [spike 0006](0006-multilingual-retrieval.md) before it, both
attribute unconditional rank fusion to
[ADR-0010](../adr/0010-sqlite-storage.md). **ADR-0010 does not contain it.** Its
Decision section names the driver, Drizzle, `sqlite-vec` and two FTS5 indexes; it
mentions fusion once, in passing, as something an empty lexical result would
poison.

The fusion rule lives in [CONCEPTS §8](../CONCEPTS.md), and it is not what either
spike modelled:

> Retrieval fuses a lexical index and a vector index by reciprocal rank fusion,
> **weighted by salience** — recency decay, access count, and the trust level of
> the source.

No arm in this spike weighted anything by salience. **This is the second time in
this project a criterion has been argued against the wrong document** — the first
was ADR-0006's wake budget, which was never in ADR-0006 either. Once is a slip;
twice is a habit worth naming, and the habit is quoting a decision from memory
instead of opening it.

Spike 0006's report has been corrected.

## What survives, across both spikes

Two things, and they are narrower than either spike's headline:

1. **Unconditional 1:1 fusion is measured harmful on semantic queries.** Spike
   0006: −16.2 points of recall@1 and −0.109 MRR for `bge-m3` at 41 items. Spike
   0007 is consistent: no lexical weight from 0.1 to 0.9 beat vector-alone on the
   combined set.
2. **At 1000 items on this corpus, pure vector answered 9 of 12 exact-identifier
   queries and the lexical index answered 11 of 12.** One paired comparison, one
   corpus realisation, not statistically resolvable.

That is enough to mark CONCEPTS §8's fusion rule **open** — it is a plausible
default that has never been validated and now has evidence against one form of it.
It is **not** enough to prescribe a replacement, and none is proposed.

## What a fifth attempt would need

Recorded so the next person does not rediscover it:

- **Distractor ranges centred on each target**, not ascending from a floor, with
  the crowding asserted in code rather than described in a comment.
- **Repeated identifiers**, so lexical retrieval has to discriminate rather than
  match a hapax.
- **Isolated variables**: an `rrf([lex, vec])` arm and a gated
  `rrf(rrf(lex,tri), vec)` arm, so the gate and the trigram index move
  separately.
- **Enough queries that one is not worth 8 points** — this needs hundreds, which
  makes it a different kind of exercise from a spike.
- **Salience weighting**, since that is what the design actually specifies.
- **A control corpus that grows on the semantic side too**, so "scale" means the
  corpus rather than one half of it.

The fourth item is why this stops here. Per `spikes/README.md`: *if a spike is
turning into a project, it is the wrong spike.* This one was rewritten four
times, and the version that would answer the question is a benchmark, not a
spike.

## Reproducing it

```bash
cd spikes/0007-lexical-routing
pnpm install
pnpm start
```

**The numbers it prints are not usable as evidence**, for the reasons above. The
harness is kept because the defects are easier to see in running code than in a
description of them.
