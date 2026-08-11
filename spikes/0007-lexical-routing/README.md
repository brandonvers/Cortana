# Spike 0007 — Is the lexical index a specialist or a voter?

**✅ This spike consumes no AI usage.** It runs against a local Ollama and one
model, `bge-m3`, chosen by [spike 0006](../../docs/spikes/0006-multilingual-retrieval.md).

## The question, and why 0006 could not answer it

[ADR-0010](../../docs/adr/0010-sqlite-storage.md) carries two lexical indexes and
a vector index, and fuses all three on every query. Spike 0006 measured that and
found it **actively harmful**: on the best model, unconditional fusion cost 16
points of recall@1 and 0.109 of MRR against using the vector index alone.

The obvious conclusion — delete the lexical indexes — does not follow, and 0006
said so. Its test set was almost entirely *semantic* queries, which is the ground
embeddings are strongest on. It contained essentially none of the queries lexical
search exists for:

> an invoice number, a registration, a date, an email address, a part code

A 1024-dimension vector cannot reliably separate `2026/0847` from `2026/0874`.
Those tokens are near-identical in embedding space and exactly distinct in a
lexical index. 0006 never asked bge-m3 to try, so its verdict on fusion was
measured on the half of the problem where lexical search has nothing to add.

**This spike builds the missing half first, then asks how to combine them.**

## Pass criteria, stated before running

| # | Criterion | Threshold |
|---|---|---|
| 0 | The dataset is coherent | no query expects a missing item |
| 1 | Ollama reachable, `bge-m3` present | — |
| 2 | **Pure vector search FAILS on exact-match queries** | **recall@1 < 60%** — demonstrated, not assumed |
| 3 | **Lexical search succeeds on them** | **recall@1 ≥ 90%** |
| 4 | Pure vector still wins on semantic queries | vector MRR > lexical MRR on the semantic half |
| 5 | **Some strategy beats pure vector on the combined set** | **MRR strictly greater** |
| 6 | **…without regressing the semantic half** | within 0.02 MRR of pure vector there |
| 7 | Routing costs nothing meaningful | < 5 ms per query, excluding the embed |

**Criterion 2 is the load-bearing one, and it is written to be falsifiable.** If
pure vector search handles exact identifiers fine, then the lexical indexes have
no specialist role either, and the honest answer to ADR-0010 is to delete them
rather than to reposition them. This spike is allowed to reach that conclusion.

Criterion 5 is the one that justifies keeping anything. If no strategy beats pure
vector on a set deliberately built to contain lexical search's best case, nothing
will.

**All criteria are evaluated at the largest corpus size.** See below for why that
is not a detail.

## Scale is the variable, and run 1 got this wrong

The first run of this spike measured **one corpus size, 28 items**, and every
strategy scored 100% recall@1 on the exact half — pure vector search included.
Two things followed, and only one of them was interesting.

The dull one: the hypothesis was refuted at that size. `bge-m3` separates
`2026/0847` from `2026/0874` perfectly well when they are the only two candidates
that look alike.

The useful one: **four strategies tied at MRR 1.000, so the test ranked nothing.**
A benchmark whose baseline scores full marks has no headroom and cannot tell any
two approaches apart. It was not evidence that vector search wins; it was evidence
that the question had been asked at a size where it does not arise.

At 28 items a query naming an invoice number has to beat **one** near-identical
rival. A real memory holds thousands, and forty invoices from the same customer
differing only in a number is a different problem. Spike 0006 recorded "nothing
about scale" as its own limitation, and this spike then walked into it.

So the corpus is padded with generated distractors in the same shape as the real
items, and the result is a **curve over corpus size** — 28, 100, 300, 1000 by
default, settable with `SCALES=`. The question changes from *"does vector search
handle identifiers"*, which has no fixed answer, to **"up to what corpus size does
it"**, which does.

Everything is embedded once at the largest size and each smaller point reuses a
prefix, so the curve costs one embedding pass rather than one per point.

## The strategies

All five run on the same embeddings and the same indexes, so the comparison is
between combination rules and nothing else.

| Strategy | Rule |
|---|---|
| `vector` | Vector index only. **The baseline to beat**, and 0006's winner. |
| `rrf-staged` | `RRF(RRF(lex, tri), vec)`. What ADR-0010 says today, in its better arithmetic. |
| `rrf-weighted-*` | Weighted RRF at lexical weights 0.1, 0.2, 0.3, 0.5, 0.7 and 0.9. Answers whether fusion fails **because it is fusion**, or only because 0006 weighted the sides 1:1. If every weight loses to pure vector, no tuning rescues it. |
| `router-shape` | If the query *looks* like it contains an identifier — digits, an email, a code — use lexical; otherwise vector. A regex on the query, no model, no index lookup. |
| `router-confidence` | Always run lexical; use it only when **its own bm25 score says it is confident** — a top hit far ahead of the runner-up. Measures the result rather than guessing from the query. |
| `router-both` | Lexical only where it is both plausible by shape and confident by score. The conjunction, in case either signal alone is too eager. |

`router-confidence` is the interesting one. The other four decide in advance;
this one lets the index report whether it found something selective, which is
what bm25 already computes and nothing currently reads.

## The dataset

Two halves, and the split is the point.

**Exact-match half.** Items deliberately built as **near-duplicate pairs** that
differ only in an identifier — two invoices, same customer, same wording,
different number; two jobs on the same car model with different registrations.
Queries ask for one of the pair by its identifier. This is the sharpest possible
test: semantically the two items are indistinguishable, and lexically they are
trivially distinct.

**Semantic half.** A subset carried over from 0006, unchanged, purely as a
regression check for criterion 6. A strategy that fixes exact matching by
breaking semantic retrieval has not helped.

The set is generic — invoices, parts, appointments, addresses — with no personal
material, and committed so the result is reproducible.

## Running it

```bash
cd spikes/0007-lexical-routing
pnpm install
pnpm start
```

| Variable | Default | |
|---|---|---|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | |
| `EMBED_MODEL` | `bge-m3` | The default chosen in 0006. |
| `SCALES` | `28,100,300,1000` | Corpus sizes to measure. The largest sets the embedding cost and is where the criteria are judged. |
| `VERBOSE` | off | `VERBOSE=1` prints per-query ranks at the largest scale. |

Embedding ~1000 items on a CPU-only Ollama takes several minutes — spike 0006
measured `bge-m3` at roughly 250 ms per item. That pass is the only slow part;
everything after it is instant. `SCALES=28,100` is a quick sanity run.
