# Spike 0003 — Concurrent long-lived agent sessions

**Date:** 2026-08-10 · **decision recorded** 2026-08-11
**Verdict:** ✅ **[ADR-0005](../adr/0005-hybrid-execution-topology.md) confirmed.**
✅ **[ADR-0006](../adr/0006-dormancy-is-the-default.md) confirmed** — but only after
the criterion that appeared to fail turned out to be measuring something else.
**Decides:** whether session-per-resident is affordable, and whether
dormancy-by-default can hide its own latency

---

## Why this spike existed

The design gives every resident agent its own long-lived model session — the most
expensive topology available — and makes dormancy the default to pay for it. Both
were chosen on reasoning. Three things had to be true: the machine can hold a
dozen sessions, a warm turn beats a cold start, and waking a dormant agent is fast
enough not to feel slow.

That third sentence contains an ambiguity that this spike ran straight into, so it
is worth resolving before the numbers: *fast enough not to feel slow* can mean
"fast in absolute terms" or "not much slower than never sleeping at all". Only the
second is a fact about dormancy. The spike was written against the first.

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
| Warm turn (median) | 1,800 ms | 2,882 ms | **3,290 ms** |
| Pre-warmed wake (median) | 2,456 ms | 2,330 ms | **3,095 ms** |
| Cost per turn | $0.0086 | $0.150 | **$0.203** |

Against the criteria as they were written at the time, the realistic column
missed the 3,000 ms latency budget on both rows. Working out why is what produced
the result below, so the numbers are left unannotated here and read properly
further down.

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

### The 3-second budget fails, and only on the realistic profile

This is what the run reported, kept exactly as it came out:

```text
minimal    wake median 2,330 ms   ✅ under the 3,000 ms budget
realistic  wake median 3,095 ms   ❌ over it
```

The warm turn failed the same way: 2,882 ms on `minimal`, 3,290 ms on `realistic`.

Both misses are small — 3% and 10% over — and the spread is wide, with wake
samples ranging 2,366–4,457 ms. But **the direction is not noise**: the comparison
is controlled, with the same machine, model and round count, and one variable
changed.

Had this spike stayed on its `minimal` numbers, the system would have been
designed against a budget it does not meet. That is the entire argument for
measuring the thing you are going to run — and it holds regardless of what
happened to the budget next.

### The budget was attributed to the wrong decision

Chasing the failure produced the actual finding. The criterion read "pre-warmed
wake, median under 3 s", and was labelled as ADR-0006's. **ADR-0006 does not
contain that number and never did.** What ADR-0006 decides is whether agents
should sleep by default, and the cost of *that* is not how long a turn takes — it
is how much longer a turn takes **because the agent was asleep**. Put the two
columns side by side and the question answers itself:

| | warm turn (kept awake) | pre-warmed wake (was dormant) | dormancy costs |
|---|---|---|---|
| realistic / sonnet | 3,290 ms | 3,095 ms | **−195 ms** |
| minimal / sonnet | 2,882 ms | 2,330 ms | **−552 ms** |
| minimal / haiku | 1,800 ms | 2,456 ms | **+656 ms** |

**Dormancy costs somewhere between −0.55 s and +0.66 s.** It is, to within the
noise of this experiment, free — while the criterion said it was 3% too slow.

The old criterion could have failed on a system where dormancy was free and passed
on one where it was ruinous, because it never compared the two. Worse, every fix
it invited — shrink the context, redefine the measurement, accept a slower
wake — was aimed at a component that was not the problem.

### Why the sign flips, which is the mechanism worth knowing

A pre-warmed wake is a **first** prompt on a session whose prompt cache is cold. A
warm turn is a **later** prompt on a session whose cache is hot but which now also
carries the earlier exchange. Two effects, opposed:

- Cold cache makes the wake slower.
- The accumulated conversation makes the warm turn slower.

Which one wins depends on where the model spends its time. On sonnet, generation
dominates and the extra input of a continuing conversation costs more than the
cold cache, so the wake comes out ahead. On haiku, generation is cheap enough that
the cold cache is visible, and the wake costs 0.65 s more.

This is worth knowing beyond this spike: it means **a long-lived session is not
unconditionally cheaper than a fresh one**, and there is a conversation length past
which resetting a session beats continuing it. Nothing here measures where that
point is. It is a real open question for the memory design.

## What was decided

Three options were put to the owner, and the answer was to **separate the two
questions** the single threshold had merged:

**ADR-0006 keeps a criterion about dormancy.** Criterion 4 is now "the wake median
is at most 1 s above the warm median" — the marginal cost of sleeping, with the
1 s drawn from what is noticeable when added to an already multi-second reply, not
from what the measurement produced. All three configurations pass it.

**The absolute figure became a product decision.** How long a user should wait for
a reply is not a lifecycle question. The measured ~3.2 s was **accepted for now**
and recorded in the product brief with the trigger that would reopen it. Spike
criterion 3 keeps an absolute check at 4,000 ms against the *slower* of the warm
and wake medians, labelled in the harness as a **regression guard** — set above
what was accepted so drift is caught, not a target anything is designed to hit.

**Neither of the other two options was taken, and the reasons are worth recording.**
Re-stating the budget as time-to-first-token was rejected on the architecture, not
on the arithmetic: [ADR-0014](../adr/0014-kernel-mediated-reports.md) holds and
aggregates reports, so for delegated work the user sees nothing until the main
agent has synthesised, and the chat surface delivers finished messages rather than
a token stream. First-token is not the latency this product's users experience, so
adopting it would have measured something no one feels. Reducing the ~36,000-token
context remains a genuine lever — for cost as much as latency — but it is a design
change, and it was not needed to resolve a criterion that was mis-aimed to begin
with. It stays available if the accepted response time stops being acceptable.

### Pre-warming still earns its place

3,095 ms against 6,211 ms cold. Without pre-warming, waking a dormant agent is a
full cold start — roughly double a turn — and *that* is where dormancy would have
become expensive. The presence engine is load-bearing, and this is the measurement
that says so.

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
  before any budget is set from it — and the dormancy penalties in the table above
  (−552, −195, +656 ms) are of the same order as that spread. The *direction* of
  the finding is safe, because dormancy is cheap on every configuration measured;
  the individual figures are not precise.
- **Where continuing a session stops being cheaper than restarting one.** The sign
  flip shows the two costs exist and trade against each other; nothing here maps
  the curve. It needs its own measurement before any session-reset policy is
  written.

## Reproducing it

```bash
cd spikes/0003-concurrent-sessions
pnpm install
ROUNDS=3 pnpm start                    # realistic profile, sonnet
PROFILE=minimal ROUNDS=3 pnpm start    # the comparison
MODEL=haiku ROUNDS=3 pnpm start        # the cheap tier
```
