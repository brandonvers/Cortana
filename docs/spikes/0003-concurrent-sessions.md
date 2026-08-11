# Spike 0003 — Concurrent long-lived agent sessions

**Date:** 2026-08-10
**Verdict:** ✅ **[ADR-0005](../adr/0005-hybrid-execution-topology.md) confirmed.**
❌ **[ADR-0006](../adr/0006-dormancy-is-the-default.md)'s wake budget fails under a
realistic profile** — and that needs a decision, not a re-run.
**Decides:** whether session-per-resident is affordable, and whether
dormancy-by-default can hide its own latency

---

## Why this spike existed

The design gives every resident agent its own long-lived model session — the most
expensive topology available — and makes dormancy the default to pay for it. Both
were chosen on reasoning. Three things had to be true: the machine can hold a
dozen sessions, a warm turn beats a cold start, and waking a dormant agent is fast
enough not to feel slow.

## Environment

| | |
|---|---|
| OS | Debian GNU/Linux 13 (trixie), x64 |
| CPU | Intel Xeon E5-2695 v2 @ 2.40 GHz × 48 |
| Memory | 62.9 GB total, 58.3 GB free |
| Node.js | 24.19.0 · Agent SDK 0.3.226 |

Measured across two models and two profiles. **The profile turned out to matter
more than the model**, which is the most useful thing this spike produced.

### What the profiles are

`minimal` is what the first four runs used: no tools, no setting sources, no
session persistence, a five-word prompt. `realistic` is what a Cortana resident
actually carries — a full persona, a six-tool memory surface with real
descriptions, read-only file tools, the user's setting sources, session
persistence, and a ~2,500-token retrieved-memory block on every turn.

## Result

| | minimal / haiku | minimal / sonnet | **realistic / sonnet** |
|---|---|---|---|
| Memory per session | 264 MB | 264 MB | **263 MB** |
| Cold start (median) | 5,412 ms | 5,466 ms | 6,211 ms |
| Warm turn (median) | 1,800 ms | 2,882 ms | **3,290 ms** ❌ |
| Pre-warmed wake (median) | 2,456 ms | 2,330 ms | **3,095 ms** ❌ |
| Cost per turn | $0.0086 | $0.150 | **$0.203** |

### Memory does not move — at all

**263 MB against 264 MB.** Adding a persona, six MCP tools, three file tools,
setting sources and session persistence changed resident memory by less than half
a percent. The figure has now held at 262, 263, 264 and 265 MB across four runs,
two profiles, two models and two scales.

The reason bounds the claim as well as explaining it: the measurement uses
`startup()`, which initialises a session **without sending a prompt**. Tools and
context live in the request, not in the process. So this is a solid figure for an
*idle* resident — which, under dormancy, is what most of them are — and it says
nothing about growth during sustained work.

**[ADR-0005](../adr/0005-hybrid-execution-topology.md) stands with room to spare.**
Twelve residents idle at 3.1 GB: 5% of this machine.

### The wake budget fails, and only on the realistic profile

This is the finding, and it exists only because the profile was made realistic:

```text
minimal    wake median 2,330 ms   ✅ under the 3,000 ms budget
realistic  wake median 3,095 ms   ❌ over it
```

The warm turn fails the same way: 2,882 ms on `minimal`, 3,290 ms on `realistic`.

Both failures are small — 3% and 10% over — and the spread is wide, with wake
samples ranging 2,366–4,457 ms. But **the direction is not noise**: the comparison
is controlled, with the same machine, model and round count, and one variable
changed.

Had this spike stayed on its `minimal` numbers, the system would have been
designed against a budget it does not meet. That is the entire argument for
measuring the thing you are going to run.

### Pre-warming still earns its place

3,095 ms against 6,211 ms cold. Halving the wake is worth the presence engine
wherever the budget finally lands.

## What has to change

**The 3-second budget was set before anything was measured, and it is not met.**
Three honest options, none of which is a re-run:

1. **Accept ~3.1 s** as what waking a dormant agent costs, and write that into
   ADR-0006 rather than leaving a threshold nothing meets.
2. **Change what is measured.** This budget counts prompt-to-*complete*. For a
   chat reply the felt latency is time-to-*first-token*, because the text streams.
   The harness already records first-token separately. Re-stating the budget
   against the number a user actually experiences is defensible — **but it has to
   be argued on its merits, not adopted because it turns a red result green.**
3. **Reduce the work.** The realistic profile carries ~36,000 tokens of context
   more than minimal. A smaller retrieved-context block, or lazily loaded tool
   definitions, would move this — a design change with its own costs.

This is the owner's decision. What the spike establishes is that **leaving
ADR-0006 as written is not among the options**, because it now records a threshold
the system does not meet.

## Cost

**$0.203 per turn** on the realistic profile with sonnet, against $0.0086 on
minimal with haiku — a factor of 24 between the cheapest measurement and the
realistic one.

The token breakdown says where it goes: 223,984 cached tokens read per realistic
turn against 187,984 on minimal. The ~36,000-token difference is the persona, the
tools, and the retrieved-memory block.

Two runs at three rounds cost **$1.82 and $1.35**. That is what measuring properly
costs, recorded so the trade is visible rather than implied.

## What this does **not** prove

- **Idle memory, not working memory.** `startup()` sends no prompt, so context
  growth during sustained work is unmeasured. A resident mid-conversation holds
  more.
- **`opus` was not measured**, deliberately: a sonnet turn costs $0.20 on this
  profile and opus is a multiple of it. If the main agent is to run on opus, its
  latency and cost need their own measurement before ADR-0006 is settled.
- **Three rounds** is enough to see a controlled difference between profiles, not
  enough to characterise the tail. The 2.4–4.5 s wake spread deserves more samples
  before any budget is set from it.

## Reproducing it

```bash
cd spikes/0003-concurrent-sessions
pnpm install
ROUNDS=3 pnpm start                    # realistic profile, sonnet
PROFILE=minimal ROUNDS=3 pnpm start    # the comparison
MODEL=haiku ROUNDS=3 pnpm start        # the cheap tier
```
