# 0012. Embeddings run locally, behind an interface

**Status:** Accepted
**Date:** 2026-08-10

## Context

The memory system fuses lexical and vector search. The vector half carries most
of the semantic load, and it carries **almost all** of it for any language SQLite
does not stem — see [0010](0010-sqlite-storage.md).

Three ways to produce embeddings were considered: **in-process ONNX** through a
JavaScript transformers runtime, a **local model server** such as Ollama, or a
**hosted embedding API**.

Two constraints narrowed it. The system stores private correspondence and
personal material, so **sending it to a third party for embedding is not
acceptable by default**. And a hosted API puts a network round trip on every
memory write, making the memory system fail whenever the network does.

Model choice matters more than usual. Benchmarks of multilingual embedding models
vary widely by language, and several well-regarded models list a specific set of
supported languages that does not include every language a user might write in.
An English-first model degrades **silently** on other languages: retrieval simply
gets worse, with no error to notice.

## Decision

**Embeddings are produced locally, by default through a local model server, behind
a pluggable `Embedder` interface.**

- The default model is a **genuinely multilingual** one, chosen from measurement
  rather than reputation, sized to run on modest hardware including CPU-only.
- The model is **configurable**, because the right size depends on the user's
  machine.
- The interface admits an in-process ONNX implementation and a hosted one, so a
  user with different constraints can choose differently.
- **The model identity is stored per vector row.** Vectors from different models
  are not comparable, so mixing them silently corrupts retrieval. Changing the
  model requires re-embedding, and the stored identity is what makes that
  detectable rather than a mystery.

## Consequences

- Nothing leaves the machine, and the memory system works offline.
- No per-query cost, so retrieval can be used freely rather than rationed.
- **The local model server is an extra process** the user installs and runs. This
  is the real cost of the decision. It is contained by the project's "off means
  off" rule: a user who does not enable memory never runs it.
- Embedding quality is bounded by what fits on the user's hardware, which is a
  genuine ceiling compared to a hosted frontier model.
- Re-indexing on model change is a real operation that has to be supported, not
  a footnote.

## Alternatives considered

**In-process ONNX.** No extra process, simplest deployment, and the initial
recommendation. Not rejected — it stays as an implementation of the same
interface — but not the default, because the local server offers better model
choice for the languages that need it most.

**Hosted embedding API.** Best quality, no local resources. Rejected as a default
on privacy grounds and because it makes memory writes depend on the network. It
remains available to users who prefer that trade-off.

**English-first models.** Rejected explicitly. The failure mode is silent
degradation, which is the most expensive kind to discover.

## Revisit when

Measured retrieval quality on a real test set says a different model or a
different runtime wins. This decision names an interface and a default, and the
default is expected to change as models improve.
