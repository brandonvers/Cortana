# Spike 0003 — Concurrent long-lived agent sessions

**Date:** 2026-08-10
**Verdict:** ✅ **Pass** on the decisive questions. One criterion was badly
designed and is replaced for future runs — see "A criterion that deserved to fail".
**Decides:** whether the execution topology in
[ADR-0005](../adr/0005-hybrid-execution-topology.md) is viable at all, and whether
dormancy-by-default in [ADR-0006](../adr/0006-dormancy-is-the-default.md) can hide
its own latency

---

## Why this spike existed

The design gives every resident agent its own long-lived model session. Each is a
separate process holding its own context. That is the most expensive choice
available, and it was made on reasoning rather than measurement. Three things had
to be true:

1. The machine can hold several at once
2. A warm turn beats a cold start, or long-lived sessions buy nothing over
   spawning per request
3. Waking a dormant agent is fast enough that dormancy-by-default does not make
   the assistant feel slow

## Environment

| | |
|---|---|
| OS | Debian GNU/Linux 13 (trixie), x64 |
| CPU | Intel Xeon E5-2695 v2 @ 2.40 GHz × 48 |
| Memory | 62.9 GB total, 58.3 GB free |
| Node.js | 24.19.0 |
| Agent SDK | 0.3.226 |
| Model | `claude-haiku-4-5-20251001` (confirmed in the run, not assumed) |

Two runs: one at 5 sessions, one at 12. Twelve is the upper bound the product
brief commits to supporting.

## Result: memory

| | 5 sessions | 12 sessions |
|---|---|---|
| Processes spawned | 5 | 12 |
| Total resident memory | 1,310 MB | 3,170 MB |
| **Per session** | **262 MB** | **264 MB** |
| Twelve residents projected | 3.1 GB | 3.1 GB |
| Share of this machine | 5% | 5% |

**262 MB and 264 MB.** The cost per session is flat from five to twelve — no
shared-memory effect that collapses at scale, and no per-session growth that
compounds. Twelve resident agents, all awake simultaneously, would use **5% of
this machine's memory**.

This is the number ADR-0005 was waiting for, and it is not close to a constraint.
The topology's expensive choice turns out to be cheap on this hardware. Memory
will not be what limits the roster; the provider's usage limits will.

Session initialisation — spawning the process and completing the handshake, with
no model call — took **1.2 to 2.2 seconds**, consistently, at both scales.

## Result: latency

| | 5-session run | 12-session run |
|---|---|---|
| Cold start, prompt to complete | 8,524 ms | 5,331 ms |
| Warm turn on an open session | 2,874 ms | 2,140 ms |
| **Pre-warmed wake** | **1,743 ms** | **1,874 ms** |

**The pre-warmed wake is the number that matters**, because it is what a user
experiences when a dormant agent is called on. At 1.7–1.9 seconds it is
comfortably inside the 3-second budget, at both scales, on hardware whose
single-thread performance is roughly eight times weaker than the development
machine's.

ADR-0006 holds: dormancy by default does not make the system feel slow, provided
the presence engine pre-warms.

An observation worth following up rather than concluding from: **the pre-warmed
wake was faster than a warm turn on an already-open session** (1.7–1.9 s against
2.1–2.9 s). A session that has been sitting initialised and idle answered its
first prompt faster than one that had already handled a turn. That could be
context accumulation, prompt-cache behaviour, or simply variance across three
samples. It is not enough evidence to design around, but if it holds under proper
sampling it would mean dormancy is not merely acceptable for short interactions —
it is preferable, and the long-lived session's real advantage is continuity rather
than speed.

## A criterion that deserved to fail

Criterion 3 was: **a warm turn must complete in under 40% of a cold start.** It
passed at 5 sessions (2,874 ms against a 3,409 ms bar) and failed at 12 (2,140 ms
against a 2,132 ms bar) — **by eight milliseconds**.

The criterion is badly designed, and would have been badly designed whichever way
it landed. It divides by a single cold-start sample, and cold start is the noisiest
thing being measured: 8,524 ms in one run and 5,331 ms in the other, a 60%
spread, for identical work. So the bar moves with the noise. In the run where the
warm turn was **faster in absolute terms** — 2,140 ms against 2,874 ms — the
criterion failed, purely because that run's cold sample happened to be quick.

The absolute figures are stable and they answer the question a ratio was standing
in for: warm turns land at 2.1–2.9 s, cold starts at 5.3–8.5 s. Keeping a session
open is worth roughly three to six seconds per turn.

**The result is recorded as measured — five of six at twelve sessions — rather
than rewritten.** Moving a threshold after seeing the number it produced is how a
test stops meaning anything. The replacement criterion for future runs is stated
in the harness and is stricter in the way that matters:

- **warm turn under 3 s absolute**, and
- **median of at least five samples**, not one

## Cost

Three model turns, whatever the session count, because `startup()` initialises a
session without sending a prompt. Total: **$0.032 and $0.026** across the two runs,
around **$0.01 per turn** for a trivial prompt on the cheapest model.

The two runs differ by 20% for identical work, which is prompt-cache behaviour and
a reminder that a single cost sample is an anecdote. The budget governor needs
distributions, not point estimates — that is a separate measurement against
realistic prompts on the models actually used.

## What it changes

- **[ADR-0005](../adr/0005-hybrid-execution-topology.md) is confirmed with a wide
  margin.** Session-per-resident costs 264 MB, flat across scale. The consequence
  listed in that ADR — "token cost scales with the number of awake residents" —
  remains the real constraint; memory does not.
- **[ADR-0006](../adr/0006-dormancy-is-the-default.md) is confirmed.** Pre-warmed
  wake is 1.7–1.9 s against a 3 s budget. Pre-warming is load-bearing, as that ADR
  assumed: it is worth 3.5–6.8 seconds against a cold start.
- **A recorded baseline for session initialisation**: 1.2–2.2 s of process spawn
  and handshake, before any model call. That is the floor the presence engine has
  to hide.
- **Criterion 3 is replaced** for future runs, with the reasoning above recorded
  rather than the number quietly adjusted.

## Reproducing it

```bash
cd spikes/0003-concurrent-sessions
pnpm install
SESSIONS=12 pnpm start
```
