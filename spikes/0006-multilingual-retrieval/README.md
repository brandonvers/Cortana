# Spike 0006 — Does retrieval actually work in a language the stemmer does not cover?

**✅ This spike consumes no AI usage.** Everything runs against a local Ollama.
The cost is disk, VRAM and wall-clock.

[Spike 0002](../../docs/spikes/0002-sqlite-vec-fts5-multilingual.md) proved the
mechanics: `sqlite-vec` loads, FTS5 **fails** to match a stem against an inflected
form, and a trigram index rescues that single case. It proved nothing about
whether the memory system will find the right thing when someone asks it a real
question.

This spike answers that, and picks the default embedding model while it is there.

## The questions

1. **Is fused retrieval good enough to build a memory system on**, in a language
   with no stemmer?
2. **Which local embedding model should be the default?**
   [ADR-0012](../../docs/adr/0012-local-embeddings.md) says "chosen from
   measurement rather than reputation" and does not name one.
3. **Does the two-index design earn its complexity?**
   [ADR-0010](../../docs/adr/0010-sqlite-storage.md) carries `unicode61` plus
   `trigram` plus vectors. If fusing them never beats the best single part, that
   is three indexes doing one index's job.
4. **How badly do "multilingual" models degrade on a language they were not
   trained for?** ADR-0012 asserts the failure is silent. Asserting a failure mode
   is not the same as having seen it.

## Pass criteria, stated before running

| # | Criterion | Threshold |
|---|---|---|
| 0 | The test set is coherent | no query expects a missing item |
| 1 | Ollama is reachable | — |
| 2 | Candidates are installed | at least two, or there is no comparison |
| 3 | Every runnable model produces vectors | a model that cannot load is a result about that model, not a crash |
| 4 | Embeddings are deterministic | the same text twice → cosine > 0.999 |
| 5 | **Fusion beats either half alone, and the noise floor** | fused recall@5 > max(lexical, vector), **and ≥ 5 points above the random control** |
| 6 | **Fused recall@5 on the unstemmed language** | **≥ 80%** |
| 7 | **The winner does not degrade on the unstemmed language** | English minus Hungarian recall@5 **≤ 15 points** |
| 8 | Embedding latency per memory write | **p95 < 500 ms** |

### The random control, and why criterion 5 has two halves

Every run includes a **model that is not a model**: vectors hashed from the text,
carrying no meaning at all. It costs nothing and it is ranked in the same table as
the real candidates.

It is there because the first dry run of this harness — against a stub server
returning nonsense — **passed the original criterion 5**. Fusing a meaningless
ranked list into a good one shuffles the order enough to move recall by a query or
two, in whichever direction chance takes it. "Fusion beat its halves" is a bar a
random number generator can clear.

So a real model now has to beat the noise floor by five points, which on this set
is two queries. If the control ever finishes first, the harness says so in large
letters rather than quietly reporting a winner.

Criteria 5 and 7 are the ones with teeth, and both are allowed to fail:

- **5 failing** would mean ADR-0010 is carrying complexity for nothing, and the
  design should shed an index rather than keep it out of loyalty.
- **7 failing** on every candidate would mean local embedding cannot serve
  non-English users well on modest hardware, which is a product problem, not a
  tuning one.

Criterion 6's 80% is a judgement, not a measurement: below roughly four queries in
five landing the right memory in the top five, an agent that says "I don't recall"
is more useful than one that answers from what it retrieved. If the number lands
near the line, the line is the thing to argue about, and the report says so.

## The candidates, and why each is on the list

| Model | Licence | Why |
|---|---|---|
| `bge-m3` | MIT | 567M, 8k context, 100+ languages. The reference multilingual model. |
| `qwen3-embedding:0.6b` | Apache-2.0 | Best multilingual MTEB per parameter; output dimension configurable 32–1024. |
| `nomic-embed-text-v2-moe` | Apache-2.0 | Mixture-of-experts, ~100 languages, fewer active parameters per token. |
| `paraphrase-multilingual` | Apache-2.0 | 278M. The small end — what a CPU-only or 2 GB-VRAM machine can afford. |
| `granite-embedding:278m` | Apache-2.0 | **Control, expected to lose.** Its model card lists twelve languages and Hungarian is not among them. |
| `nomic-embed-text` | Apache-2.0 | **Control, expected to lose.** English-first, and by pull count the model most people reach for. |

The last two are not padding. ADR-0012 rejects English-first models on the grounds
that they degrade silently; including two models that should demonstrate it turns
that from a belief into a measurement — the same move spike 0002 made when it
required FTS5's failure to be *shown*, not assumed. If they do not lose, ADR-0012
needs rewriting.

**Licence is a gate, not a tiebreaker.** The project is MIT and every user inherits
whatever it defaults to. `embeddinggemma` scores well and is deliberately absent:
it ships under the Gemma Terms of Use, which carry usage restrictions and
downstream obligations that OSI licences do not. That is a decision to take
explicitly rather than by benchmark table.

## The test set, and its honest limitation

`dataset.ts` holds 26 Hungarian items and 12 English ones, with 28 and 12 queries.
Each query is tagged with what it is designed to break — `inflection`, `compound`,
`paraphrase`, `diacritics`, `possessive`, `distractor` — and results are reported
per mechanism, because an aggregate number hides which half of the index is
working.

Several items deliberately share vocabulary: three concern paying for something,
two concern a document expiring, three concern feeding an animal. Without that
pressure, retrieval tests flatter everything.

**This set is circular in one direction.** Its queries were written by the same
agent that wrote its items, so they cannot tell you how the system performs on
material it has never seen. It is committed anyway, because a model comparison
decided on data nobody else can re-run is a claim rather than a measurement.

The authoritative number comes from real material:

```bash
DATASET=/path/to/private-set.json pnpm start
```

Same JSON shape as `PUBLIC_DATASET`. Keep it outside the repository — it is
somebody's actual life. **Both numbers go in the report**, and where they disagree
the private one wins.

### Why Hungarian, in a framework with no domain

It stands in for the class: agglutinative, heavily suffixed, compounding, with
diacritics people omit when typing on a phone. English is present as a **control**,
not a target — the quantity criterion 7 measures is the *gap* between the two, and
a Hungarian score with nothing beside it cannot show degradation.

Adding a set for Finnish, Turkish, Estonian or Tamil in the same shape would make
this measurably better and is a good first contribution. The shape is three arrays.

## Running it

```bash
cd spikes/0006-multilingual-retrieval
pnpm install

# Pull the candidates first — about 3 GB in total.
for m in bge-m3 qwen3-embedding:0.6b nomic-embed-text-v2-moe \
         paraphrase-multilingual granite-embedding:278m nomic-embed-text; do
  ollama pull "$m"
done

pnpm start
```

The harness reports which candidates are missing and prints the `ollama pull` line
for each, so running it before pulling anything is a reasonable first step.

| Variable | Default | |
|---|---|---|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Set this if Ollama is in a container on another host or a remapped port. |
| `MODELS` | all | Comma-separated subset, e.g. `MODELS=bge-m3,nomic-embed-text`. |
| `DATASET` | the public set | Path to a private JSON set. |
| `VERBOSE` | off | `VERBOSE=1` prints the rank of the expected item for every query. |

### If Ollama runs in Docker

It is reached over HTTP, so the container is invisible to the harness — but **GPU
access is not automatic**. A container started without `--gpus` runs on CPU and
reports nothing about it, which would silently turn the latency figures into CPU
figures. Check before trusting criterion 8:

```bash
docker exec <container> nvidia-smi   # fails → the container has no GPU
```

The harness prints the *host's* GPU for the same reason: so a later reader can see
whether one was present at all.
