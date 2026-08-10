# Spike 0003 — Concurrent long-lived agent sessions

**Date:** 2026-08-10
**Verdict:** ✅ **Pass** — all six criteria, on the primary deployment target
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

1. The machine can hold a dozen at once
2. A warm turn beats a cold start, or long-lived sessions buy nothing
3. Waking a dormant agent is fast enough that dormancy does not make the
   assistant feel slow

## Environment

| | |
|---|---|
| OS | Debian GNU/Linux 13 (trixie), x64 |
| CPU | Intel Xeon E5-2695 v2 @ 2.40 GHz × 48 |
| Memory | 62.9 GB total, 58.3 GB free |
| Node.js | 24.19.0 |
| Agent SDK | 0.3.226 |
| Model | `claude-haiku-4-5-20251001`, confirmed in the run rather than assumed |

## Memory: the topology is cheap

| | |
|---|---|
| Sessions | 12 |
| Processes spawned | 12 |
| Total resident memory | 3,166 MB |
| **Per session** | **264 MB** |
| Share of this machine | **5%** |

Across four runs at two scales the figure was 262, 264, 265 and 264 MB. It does
not drift with the number of sessions: no shared-memory effect that collapses at
scale, no per-session growth that compounds.

Twelve resident agents, all awake simultaneously, use **5% of this machine's
memory**. ADR-0005 chose the most expensive topology available and it turns out to
be cheap. **Memory will not limit the roster; the provider's usage limits will** —
which is exactly the consequence that ADR listed.

Session initialisation — spawning the process and completing the handshake, with
no model call — took **1.2 to 1.8 seconds**, consistently.

## Latency: five interleaved rounds

Each round measured all three conditions in sequence, so provider slowness lands
on all three alike rather than biasing whichever ran during it.

| Round | Cold start | Warm turn | Pre-warmed wake |
|---|---|---|---|
| 1 | 5,540 ms | 2,384 ms | 2,421 ms |
| 2 | 5,412 ms | 2,310 ms | 2,537 ms |
| 3 | 5,103 ms | 1,551 ms | 2,456 ms |
| 4 | 5,610 ms | 1,601 ms | 2,766 ms |
| 5 | 5,392 ms | 1,800 ms | 2,147 ms |
| **median** | **5,412 ms** | **1,800 ms** | **2,456 ms** |
| min / max | 5,103 / 5,610 | 1,551 / 2,384 | 2,147 / 2,766 |

The ordering is now unambiguous, and it makes sense: an open session with warm
context beats a pre-warmed empty process, which beats a cold spawn.

**What dormancy actually costs: 656 ms.** That is the gap between waking a
pre-warmed agent and holding one permanently open. In exchange, a dormant agent
consumes no memory, no context and no tokens. That is a very cheap price, and it
is the strongest argument for ADR-0006 that this spike could have produced.

**What pre-warming is worth: 2,956 ms**, against spawning cold. The presence
engine is load-bearing, as ADR-0006 assumed.

### A previous observation, now closed

An earlier run suggested the pre-warmed wake was *faster* than a warm turn, which
would have implied a long-lived session's advantage is continuity rather than
speed. **Proper sampling disposes of it**: warm turns are consistently faster
(1,800 ms against 2,456 ms), in every one of the five rounds. The earlier
observation was noise, and it was recorded at the time as not being enough
evidence to design around. It was not.

### Variance drifts between runs, not within them

Within this run, cold start held between 5,103 and 5,610 ms — a spread of 10%.
Across runs on different occasions it ranged from 2,841 to 8,524 ms — a factor of
three.

**Provider latency drifts on a timescale of minutes or hours, not seconds.** Two
consequences:

- Interleaving within a run does control for it, which is why these medians are
  trustworthy where earlier single samples were not.
- **The product cannot promise a fixed reply time.** The same request may take
  three seconds or nine depending on when it is asked. The proactive gate and any
  user-facing timeout have to be written against a distribution, not an average.

## Cost

| | |
|---|---|
| Turns | 15 — five rounds × three conditions, independent of session count |
| Total | $0.1293 |
| Per turn | **$0.0086** |

This figure is **not a basis for the budget governor**. It is the cheapest model
answering a five-token prompt with no tools loaded and no memory retrieval. A real
agent turn carries a system prompt, tool definitions, retrieved context and a
larger model. Measuring that is a separate spike against realistic prompts.

What this number does establish is that the *measurement* was cheap, and that
`startup()` sending no prompt is why: session count and cost are independent.

## What it changes

- **[ADR-0005](../adr/0005-hybrid-execution-topology.md) confirmed with a wide
  margin.** 264 MB per session, flat across scale, 5% of the machine for a full
  roster.
- **[ADR-0006](../adr/0006-dormancy-is-the-default.md) confirmed, and quantified.**
  Dormancy costs 656 ms per wake and saves the memory, context and tokens of every
  agent that is not currently working. Pre-warming is worth 2,956 ms and is
  therefore required, not optional.
- **A recorded baseline for session initialisation**: 1.2–1.8 s of process spawn
  and handshake before any model call. That is the floor the presence engine has
  to hide.
- **A warning against fixed latency promises.** Between-run variance is a factor
  of three on identical work.

## How the criteria were fixed, and what that cost

This spike's latency criteria were wrong twice before they were right, and the
sequence is worth recording because the failure mode is subtle.

The first version compared a single warm sample against 40% of a single cold
sample. It failed by eight milliseconds — in the run where the warm turn was
faster in absolute terms, because that run's cold sample happened to be quick.

The fix replaced criterion 3 with an absolute budget over five samples and **left
criteria 4 and 5 sampling once**. The same mistake, left in place twice. The next
run duly failed both, and again for the wrong reason: pre-warming had not stopped
working, that run's cold sample was simply fast.

Only when all three conditions were sampled over interleaved rounds did the
measurement become capable of answering the question.

**Every measured result was recorded as it came out**, including the two that
failed. Moving a threshold after seeing the number it produced is how a test stops
meaning anything; repairing an experiment that cannot tell signal from noise is a
different act, and keeping the distinction visible is the reason this section
exists.

A separate lesson, recorded in the repository rather than here: the broken merge
that briefly left this harness unable to start was caught by nothing, because
`spikes/` had been excluded from linting on the grounds that throwaway code need
not meet project style. Style was never the point — the rule that would have
caught it flags redeclaration, not formatting.

## Reproducing it

```bash
cd spikes/0003-concurrent-sessions
pnpm install
SESSIONS=12 pnpm start
```
