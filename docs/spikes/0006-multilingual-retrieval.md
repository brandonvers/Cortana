# Spike 0006 — Retrieval quality in a language the stemmer does not cover

**Date:** 2026-08-11 · **run 1 of 2** — a second run is required, and why is the
substance of this report
**Verdict:** ⚠️ **Inconclusive on the question it was built to answer**, and
conclusive on two it was not.
**Decides:** the default embedding model, and whether
[ADR-0010](../adr/0010-sqlite-storage.md)'s three-index design earns its
complexity

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

## Result, as it came out

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

**Criteria 5 and 8 failed. 0, 1, 2, 3, 4, 6 and 7 passed.**

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

**Run 2 decides between them, and it is allowed to conclude that neither beats the
vector index alone.** If staged also loses, ADR-0010 is carrying two lexical
indexes for a memory system that would retrieve better without them, and the ADR
should be amended rather than defended. Nothing in run 1 settles that, because run
1 only measured the arithmetic that was wrong.

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

## What this does **not** establish

- **Nothing about the default model.** The winner is under a truncation cloud and
  the runner-up was measured with a fusion strategy now known to be wrong. Run 2,
  on a GPU, with the private set, decides it.
- **Nothing about scale.** Thirty-eight items, so recall@5 is the top 13% of the
  corpus — an easy target. Real memory holds thousands, where lexical precision
  matters more than it can here, and where the fusion question may answer
  differently.
- **Nothing about latency as deployed**, because the model ran on the CPU.
- **The public set remains circular.** Its queries were written alongside its
  items. The private set of real material is what settles the default; both
  numbers will be published, and where they disagree the private one wins.

## Reproducing it

```bash
cd spikes/0006-multilingual-retrieval
pnpm install
pnpm start                                    # public set
DATASET=/path/to/private.json pnpm start      # the set that decides
```
