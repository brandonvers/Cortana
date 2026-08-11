# Spike 0006 — Retrieval quality in a language the stemmer does not cover

**Date:** 2026-08-11 · two runs
**Verdict:** ✅ **`bge-m3` is the default embedding model**, on measurement.
❌ **[ADR-0010](../adr/0010-sqlite-storage.md)'s fusion does not earn its
complexity** — the lexical indexes make the best model measurably worse.
**Decides:** the default embedding model, and whether the three-index design
earns its complexity

---

## The short version

Two runs. Run 1 produced a winner and two red criteria; investigating them found
**three defects in the spike itself**, each of which changed the answer once
fixed. Run 2 is the measurement.

| | |
|---|---|
| **Default model** | **`bge-m3`** — MIT, 96.8% Hungarian recall@5, 3.2-point language gap, only model at 100% on long items |
| **Fusion** | **Harmful for good models, helpful for bad ones.** `bge-m3` loses 16 points of recall@1 and 0.11 MRR when the lexical indexes are fused in |
| **ADR-0012's fear** | Confirmed — the English-first model degrades 32 points, silently |
| **ADR-0012's shortcut** | Refuted — a model card's language list does not predict performance |
| **Still open** | Latency, because Ollama ran on the CPU throughout |

---

## Why this spike existed

[Spike 0002](0002-sqlite-vec-fts5-multilingual.md) proved the mechanics: the
extension loads, FTS5 fails on an inflected form, a trigram index rescues that one
case. It proved nothing about whether the memory system finds the right thing when
someone asks a real question, and
[ADR-0012](../adr/0012-local-embeddings.md) names a default embedding model it
never chose.

## Environment

| | |
|---|---|
| OS | Debian GNU/Linux 13 (trixie), x64 · Linux 6.12.101 |
| CPU | Intel Xeon E5-2695 v2 @ 2.40 GHz × 48 |
| Memory | 67.5 GB total, 60.9 GB free |
| Node.js | 24.19.0 · better-sqlite3 13.0.3 · SQLite 3.53.4 · sqlite-vec v0.1.9 |
| Ollama | Docker, `ollama/ollama:latest`, port 11434 published |
| GPU | **Quadro P620 (2048 MiB) present on the host, and not used** — see below |

### Everything below is a CPU number

```text
$ ollama ps
NAME             SIZE      PROCESSOR    CONTEXT
bge-m3:latest    1.2 GB    100% CPU     4096
```

The card is visible to the host — the harness printed it — but Ollama ran the
model on the CPU. The container's `NVIDIA_VISIBLE_DEVICES=all` and
`NVIDIA_DRIVER_CAPABILITIES=compute,utility` are **baked into the official image**
and would be present whether or not a GPU were ever attached, so they prove
nothing on their own. This is why the harness asks `ollama ps` rather than reading
environment variables.

**Criterion 8 (latency) is therefore a measurement of a 48-core Xeon, not of the
system as it would run.** It failed, and it may pass on the GPU; that is not yet
known.

## Run 1 — as it came out

```text
model                       dims   vec@5  FUSED@5    MRR    hu@5    en@5     gap   embed p95
paraphrase-multilingual      768  100.0%    97.5%  0.865   96.4%  100.0%    3.6%      699 ms
bge-m3                      1024  100.0%    97.5%  0.824   96.4%  100.0%    3.6%      767 ms
nomic-embed-text-v2-moe      768   97.5%    95.0%  0.812   92.9%  100.0%    7.1%      665 ms
granite-embedding:278m       768   92.5%    90.0%  0.798   85.7%  100.0%   14.3%      669 ms
qwen3-embedding:0.6b        1024   90.0%    92.5%  0.759   89.3%  100.0%   10.7%      532 ms
nomic-embed-text             768   82.5%    82.5%  0.698   75.0%  100.0%   25.0%      128 ms
random-vectors (control)     768    5.0%    70.0%  0.565   67.9%   75.0%    7.1%        0 ms

lexical alone (no model)            —       67.5%  0.603
```

**Criteria 5 and 8 failed.** Chasing both found three defects in the spike, set
out below. Run 1's winner did not survive them.

## Run 2 — after the fixes

```text
model                       dims  vec@5  flat@5  STAGED@5   MRR    hu@5    en@5    gap   trunc@5  embed p95
bge-m3                     1024   97.7%   90.7%    97.7%  0.807   96.8%  100.0%    3.2%   100.0%    677 ms
paraphrase-multilingual     768   95.3%   90.7%    95.3%  0.801   93.5%  100.0%    6.5%    66.7%    646 ms
nomic-embed-text-v2-moe     768   97.7%   88.4%    93.0%  0.785   90.3%  100.0%    9.7%   100.0%    657 ms
granite-embedding:278m      768   86.0%   83.7%    88.4%  0.771   83.9%  100.0%   16.1%    66.7%    635 ms
qwen3-embedding:0.6b       1024   83.7%   79.1%    83.7%  0.710   77.4%  100.0%   22.6%    33.3%    578 ms
nomic-embed-text            768   76.7%   76.7%    76.7%  0.633   67.7%  100.0%   32.3%    33.3%    175 ms
random-vectors (control)    768    4.7%   67.4%    65.1%  0.469   61.3%   75.0%   13.7%    33.3%      0 ms
lexical alone (no model)      —   65.1%
```

**Only criterion 8 failed, and it is a CPU number.** The three fixes each changed
the ranking:

- **Staged fusion beat flat on every model** — `bge-m3` from 90.7% to 97.7%. The
  vote-count diagnosis was right.
- **The truncation criterion dethroned run 1's winner.**
  `paraphrase-multilingual` scores **66.7%** where `bge-m3` scores **100%**. Its
  512-token window is real and now visible.
- **The language gap widened once long items existed**, from 25.0 to 32.3 points
  for the English-first model, and past the 15-point threshold for `granite`.

---

## Finding 1 — fusion made retrieval worse, and the reason is arithmetic

This is the important one, and it is the reason criterion 5 failed.

| model | vector alone @1 | fused @1 | vector alone @5 | fused @5 |
|---|---|---|---|---|
| bge-m3 | 87.5% | **72.5%** | 100.0% | 97.5% |
| nomic-embed-text-v2-moe | 82.5% | **72.5%** | 97.5% | 95.0% |
| paraphrase-multilingual | 75.0% | 80.0% | 100.0% | 97.5% |
| granite-embedding:278m | 72.5% | 72.5% | 92.5% | 90.0% |
| qwen3-embedding:0.6b | 72.5% | **65.0%** | 90.0% | 92.5% |
| nomic-embed-text | 65.0% | **60.0%** | 82.5% | 82.5% |

**Fusing the lexical indexes into a good vector ranking cost up to 15 points of
recall@1.** Four of six models got worse; one improved; one was unchanged.

The mechanism is a vote count, not a fact about lexical search. The fusion ran RRF
over three ranked lists — `unicode61`, `trigram`, and the vector index — one vote
each. But `unicode61` and `trigram` are **two views of the same lexical signal**,
so the lexical side held **two votes against the vector side's one**, while
scoring 67.5% against the vector side's 100%. The weaker signal, counted twice,
outvoted the stronger one.

That is a defect in how the spike combined the indexes, not evidence against
combining them. The harness now measures both:

- **flat** — `RRF(lex, tri, vec)`, what run 1 measured
- **staged** — `RRF(RRF(lex, tri), vec)`, one lexical vote against one vector vote

Run 2 confirmed the diagnosis: **staged beat flat on every model**, by up to 7
points. The arithmetic was wrong and fixing it recovered most of the loss.

### But fixing the arithmetic did not save the design

With staged fusion and the best model, this is the comparison that matters:

| `bge-m3` | recall@1 | recall@5 | MRR |
|---|---|---|---|
| vector index alone | **86.0%** | 97.7% | **0.916** |
| staged fusion | 69.8% | 97.7% | 0.807 |
| | **−16.2 points** | tie | **−0.109** |

**Adding the lexical indexes to a good vector index makes retrieval worse.** Not
in run 1's broken arithmetic — in run 2, with the fusion done properly.

And the effect has a shape. Per-model deltas, fused against vector-alone:

| model | its own vec@5 | Δ recall@1 | Δ MRR |
|---|---|---|---|
| `bge-m3` | 97.7% | **−16.2** | −0.109 |
| `nomic-embed-text-v2-moe` | 97.7% | **−14.0** | −0.097 |
| `paraphrase-multilingual` | 95.3% | 0.0 | −0.015 |
| `qwen3-embedding:0.6b` | 83.7% | −6.9 | −0.038 |
| `granite-embedding:278m` | 86.0% | **+2.4** | −0.004 |
| `nomic-embed-text` | 76.7% | −7.0 | −0.033 |

**The lexical indexes are a floor for weak retrieval and a ceiling for strong
retrieval.** The only model fusion helps at recall@1 is one of the two included
because it was expected to lose. The better the vector index, the more the
lexical half costs.

### Criterion 5 passed anyway, and that is a problem worth naming

Run 2 reported `PASS` on criterion 5: staged recall@5 of 97.7% against
vector-alone's 97.7%, a dead tie, which cleared a `≥` comparator — **the same
comparator this report loosened after run 1.**

That is exactly the failure the loosening was warned about, arriving one run
later. Recall@5 asks only whether the right memory landed somewhere in the top
five; it cannot see a 16-point collapse in recall@1 or 0.11 of MRR.

**Criterion 5 now judges on MRR**, and the reason is a design constraint rather
than a preference between statistics. The retrieved-context block has a token
budget — spike 0003 measured roughly 2,500 tokens of it — so a memory ranked
fifth arrives surrounded by four irrelevant ones and competes with them for the
agent's attention, or gets cut. Rank inside the window is not free, and MRR is
what registers it.

On MRR, criterion 5 **fails**: 0.807 against 0.916.

### What this means for the fusion rule

> **Correction, 2026-08-11.** This section originally attributed unconditional
> fusion to [ADR-0010](../adr/0010-sqlite-storage.md). **ADR-0010 does not contain
> it.** Its Decision names the driver, Drizzle, `sqlite-vec` and two FTS5 indexes,
> and mentions fusion once in passing. The rule lives in
> [CONCEPTS §8](../CONCEPTS.md), and it specifies fusion **weighted by salience**
> — recency decay, access count, source trust — which this spike did not model.
> Found by the adversarial review of [spike 0007](0007-lexical-routing.md); see
> that report for why this is the second such misattribution.

The design carries `unicode61` + `trigram` + vectors and fuses them. On this
evidence the unweighted fusion is not justified, but **deleting the lexical
indexes does not follow either** — the mechanism breakdown shows them carrying
`diacritics` queries at MRR 1.000, and exact-match retrieval (an invoice number, a
name, a date) is a case no embedding handles reliably and this test set barely
contains.

The shape that fits the data is **lexical as a specialist, not a co-equal voter**:
vector search as the default path, with the lexical indexes consulted for exact
tokens or when vector confidence is low. That is a design change, it needs its own
measurement, and it should be an ADR amendment rather than a quiet edit.

**This spike does not make that change. It establishes that the current one is
wrong.**

## Finding 2 — ADR-0012's fear is real, but its heuristic is not

ADR-0012 rejects English-first models because they "degrade **silently**" on other
languages. Two controls were included to test that, both expected to lose.

**`nomic-embed-text` (English-first) behaved exactly as predicted.** It finished
last, at 75.0% Hungarian against 100% English — a **25-point gap**, by far the
widest measured. There is no error, no warning, and nothing in its behaviour that
would tell a user their memory had got worse. The ADR's stated failure mode is
confirmed, and it is confirmed as *silent*.

**`granite-embedding:278m` did not behave as predicted, and this is the more
useful result.** Its model card lists twelve supported languages and Hungarian is
not one of them. It scored **85.7% Hungarian**, beat `qwen3-embedding` on fused
recall@5, and came fourth of six.

So: **a model card's language list does not predict how a model performs on a
language it does not list.** Choosing by that list would have excluded a
mid-ranking model and told you nothing about the actual last-place finisher, whose
card lists English and is honest about it.

This vindicates ADR-0012's *procedure* — "chosen from measurement rather than
reputation" — while refuting the shortcut anyone would reach for instead. Worth
recording, because the shortcut is much cheaper than the measurement and would
have looked responsible.

Run 2 sharpened both halves of this. With long items in the set, the English-first
model's gap widened from 25.0 to **32.3 points** — the failure mode gets worse on
harder material, which is the opposite of reassuring. And `granite`, whose card
still does not list Hungarian, still finished mid-table at 83.9%, though its gap
crossed the 15-point threshold at 16.1.

## Finding 3 — the test set chose the winner

`paraphrase-multilingual` came first: best MRR, tied best recall@5, half the size
of `bge-m3`, and the only model on which fusion *helped*. On the numbers above it
is the obvious default.

It has a **512-token context window.** `bge-m3` has 8192.

Every item in the test set was a single short sentence, so the limit never bound —
and the winner won on a pitch that happened to exclude its own weakness. A model
that hits its context limit does not error: it embeds the opening of the memory,
silently drops the rest, and returns a correctly-shaped vector for a truncated
document. **Not one of the nine original criteria could have detected that.**

This is the same class of mistake as
[spike 0003](0003-concurrent-sessions.md)'s minimal profile — measuring a
convenient case and reading the result as a forecast — and it is the second time
it has come up. The pattern worth naming: *a benchmark that never stresses a
dimension will crown whichever candidate is weakest on it.*

**Criterion 9 was added**, along with three long Hungarian items of 500+ tokens
each, with the queried fact deliberately in the **last sentence**. If a model
truncates, those three queries fail and nothing else changes.

Run 2 settled it:

| model | context window | truncation recall@5 |
|---|---|---|
| `bge-m3` | 8192 | **100.0%** |
| `nomic-embed-text-v2-moe` | 512 (Ollama default ctx) | 100.0% |
| `paraphrase-multilingual` | **512** | **66.7%** |
| `granite-embedding:278m` | 512 | 66.7% |
| `qwen3-embedding:0.6b` | 32k | 33.3% |
| `nomic-embed-text` | 8192 | 33.3% |

Run 1's winner loses a third of the long-item queries. `bge-m3` loses none. **The
criterion that did not exist a day ago is the one that picked the default model.**

The bottom two rows are worth noting as an unexplained result rather than a
finding: `qwen3-embedding` has a 32k window and still scored 33.3%, so its
weakness on these items is not truncation. It also dropped between runs on the
short items, which the added query instruction was supposed to improve. Something
about this candidate is not understood, and the honest position is to say so
rather than to attribute its loss to a cause that does not fit.

## What changed for run 2, and how to judge the changes

| Change | Why | Direction |
|---|---|---|
| Staged fusion measured alongside flat | the lexical side had two votes to one | new measurement, no threshold moved |
| Criterion 5 relaxed from `>` to `≥` | it conflated "is fusion worth it" with "is our fusion arithmetic right" | **loosened** |
| Criterion 9 added | the winner's context limit was invisible to the set | **tightened** |
| Three long items added | as above | **tightened** |
| `qwen3-embedding` given its query instruction | its card puts the cost of omitting it at 1–5% of retrieval performance; run 1 embedded queries and documents identically for every model | fairer to one candidate |

The one that needs defending is criterion 5's comparator, because relaxing a
threshold after a red result is exactly the move this project refuses to make.
The defence: the underlying numbers are unchanged and still printed, both fusion
strategies are now reported with their difference on every run, and the
vector-alone column sits in the same table where anyone can see fusion losing to
it. If fusion is not worth its complexity, run 2 will say so in the open rather
than through a `>`.

The `qwen3-embedding` change is worth being precise about: the instruction is
worth 1–5% by its own card, and qwen3 lost by 10 points of vector recall@5. **The
handicap does not explain its result**, so this is a fairness fix, not a rescue.

## The decision

**`bge-m3` is the default embedding model.** It is first on MRR, tied first on
recall@5, has the narrowest language gap at 3.2 points, is the only model that
loses nothing on long items, and it is **MIT** — the most permissive licence in
the field, which matters because every user inherits the default.

`embeddinggemma` was measured on request and is recorded, but is **not eligible to
be the default**: it ships under the Gemma Terms of Use, which carry use
restrictions and downstream obligations that MIT and Apache-2.0 do not. The
harness refuses to name a non-OSI model as the default regardless of where it
lands in the table, and says so out loud when it scores highest.

This is a decision on the public set. The private set of real material can
overturn it, and if it does, the private number wins.

## Why every number here is a CPU number

The host has a Quadro P620 and Ollama refused it:

```text
level=WARN source=cuda_compat.go:70 msg="NVIDIA driver too old"
  device="Quadro P620" compute=6.1 driver=550 required_driver="570 or newer"
```

Everything else on that machine is configured correctly — container toolkit 1.19.1
installed, the card visible inside the container, the compose file reserving it.
The driver is the only blocker.

**Fixing it is narrower than it looks, and may not be worth doing.** Driver
branches 570 and 580 support Pascal; **590 dropped it**, so "install the latest"
would remove this card's support entirely — the one case so far where this
project's standing rule to take the newest version is the wrong move. 580 is the
last branch, supported on Quadro until October 2028.

And the gain is uncertain in direction, not only in size. The P620 has roughly
40 GB/s of memory bandwidth against a dual-socket Xeon's quad-channel DDR3; for a
567M-parameter model on short inputs the bottleneck is bandwidth, so the card may
be **slower** than the 48 threads it would replace. Its 2 GB of VRAM fits
`bge-m3`'s 1.2 GB with little to spare.

The harness printed only p95, which hid the one distinction that decides whether
hardware is the lever at all. It now prints both, and a targeted re-run answered
it:

```text
bge-m3   embed p50 621 ms / p95 670 ms
```

**Flat. No tail.** The model genuinely costs ~620 ms per query on this CPU, so
model reloading and scheduling are not the explanation and `keep_alive` would
change nothing.

That also **corrects an earlier claim in this report's own draft**, which guessed
the P620 might be slower than the CPU on bandwidth grounds. The measurement says
otherwise: `bge-m3` is 1.13 GB at F16, and a dual-socket Xeon has enough bandwidth
to stream that in roughly 25 ms. Taking 620 ms means the work is **compute-bound,
not bandwidth-bound** — and on compute the P620's ~1.3 TFLOPS against what these
Xeons realistically achieve is a genuine advantage. A driver upgrade to 580 could
plausibly be worth several times, not nothing.

Quantisation would have been the cheaper lever, and it is not available: every
`bge-m3` tag on Ollama is the same 1.2 GB F16 build.

**The driver decision is nevertheless deferred, because criterion 8 encodes an
undeclared assumption.** Its 500 ms threshold only means something if the query
embedding is *serial* with the turn. Spike 0003 measured a wake at ~3 s; if
retrieval runs concurrently with waking the agent and assembling its context, the
620 ms disappears entirely and no hardware change is needed. If it is serial, it
is 19% on top of every turn and the driver matters.

**Which of those is true has never been decided**, so the threshold is neither met
nor meaningful yet. That is recorded as an open architecture question rather than
quietly relaxed — moving this threshold after seeing a red number is exactly the
move refused twice already in this project.

Criterion 8 was also misnamed. It read "affordable per memory **write**", but the
harness measures one embed per **query**, on the critical path. Writes are batched
— that is the `index time` line — and can run in the background, where the same
milliseconds cost nothing. The threshold was attached to the cheaper half.

## What this does **not** establish

- **Nothing about latency on a GPU**, for the reasons above.
- **Nothing about scale.** Forty-one items, so recall@5 is the top 12% of the
  corpus — an easy target. Real memory holds thousands, where lexical precision
  matters more than it can here, and **the fusion finding may not survive it**:
  the case for a lexical index is strongest exactly where this test set is
  weakest.
- **Nothing about exact-match retrieval.** Invoice numbers, names, dates — the
  queries embeddings are worst at and lexical indexes are built for. The set
  barely contains any, which is precisely why the fusion result should be read as
  "not justified on this evidence" rather than "the lexical indexes are useless".
- **`qwen3-embedding`'s result is not understood**, as set out above.
- **The public set remains circular.** Its queries were written alongside its
  items. The private set of real material is what confirms or overturns the
  default; both numbers get published.

## Reproducing it

```bash
cd spikes/0006-multilingual-retrieval
pnpm install
pnpm start                                    # public set
DATASET=/path/to/private.json pnpm start      # the set that decides
```
