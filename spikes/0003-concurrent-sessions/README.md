# Spike 0003 — Can the hardware sustain N concurrent long-lived agent sessions?

**⚠️ This spike consumes AI usage.** It is the only one so far that does. See
"Cost" below — it is designed to be small, and the design is the point.

This is the measurement that [ADR-0005](../../docs/adr/0005-hybrid-execution-topology.md)
and [ADR-0006](../../docs/adr/0006-dormancy-is-the-default.md) rest on. If it
fails, the answer is not a tuning change; it is a redesign of what deserves a
session of its own.

## The question

The design gives every resident agent its own long-lived model session. Each one
is a separate process holding its own context. Three things have to be true for
that to work:

1. The machine can hold several at once without exhausting memory
2. A warm turn is meaningfully faster than a cold start, or long-lived sessions
   buy nothing over spawning per request
3. Waking a dormant agent is fast enough that dormancy-by-default does not make
   the assistant feel slow

## Pass criteria

| # | Criterion | Threshold |
|---|---|---|
| 1 | All sessions start and survive the run | no session dies |
| 2 | Resident memory per session | measured; twelve must fit in a quarter of the machine's memory |
| 3 | Turn latency, whichever path served it | **slower of warm/wake median under 4 s** (regression guard) |
| 4 | The latency dormancy *adds* | **wake median at most 1 s above warm median** |
| 5 | Pre-warming is worth its complexity | **wake median below cold median** |
| 6 | Cost | measured and reported, so the budget governor has real numbers |

### Criteria 3 and 4 were rewritten after the first realistic run — and why that is not moving the goalposts

The original pair was "warm turn median under 3 s" and "wake median under 3 s",
the second labelled as ADR-0006's budget. The realistic profile missed both, at
3,290 ms and 3,095 ms, and that prompted a look at what the criteria were for.

**Criterion 4 was measuring the wrong quantity.** ADR-0006 decides whether agents
should be dormant by default. The cost of that decision is not how long a turn
takes — it is how much *longer* a turn takes because the agent was asleep. The old
criterion could fail on a system where dormancy was completely free, and pass on
one where it was ruinous, because it never compared the two. It now measures the
difference, which is the number the decision actually turns on.

**Criterion 3's threshold was never a requirement.** Three seconds was a guess
written before anything was measured. It has been replaced by a figure the owner
accepted after seeing the measurement, and it is labelled here as what it is: a
**regression guard**, set ~20% above the accepted median so drift is caught, not a
target anything is designed to hit.

That is the line. Relaxing a threshold so a result goes green is dishonest;
replacing a threshold that measured the wrong quantity is the only thing you can
do once you notice. **The failing numbers stay in the report exactly as they came
out**, together with the decision they produced, so anyone can judge the swap for
themselves.

### How the latency criteria were fixed, twice before that

The first version compared a single warm sample against 40% of a single cold
sample. It failed by eight milliseconds — in the run where the warm turn was
**faster in absolute terms**, purely because that run's cold sample happened to be
quick.

The fix at the time replaced criterion 3 with an absolute budget over five
samples, and left criteria 4 and 5 sampling once. **That was the same mistake,
left in place twice**, and the next run duly failed both: the pre-warmed wake came
back at 1,743 ms, 1,874 ms and then 4,623 ms across three runs of identical work,
while cold start ranged from 2,841 ms to 8,524 ms.

Against that much variance a single sample per condition decides the verdict by
coin toss, and it did — twice, in opposite directions.

All three conditions are now sampled over **interleaved rounds**: each round
measures cold, warm and pre-warmed, so a period of provider slowness lands on all
three alike instead of biasing whichever happened to run during it. Each round's
pre-warmed handle is created at the round's start and queried at its end, giving
every wake sample the same realistic idle gap — a dormant agent pre-warmed some
seconds ago, not one queried the instant its process appeared.

**Every measured result stands in [the report](../../docs/spikes/0003-concurrent-sessions.md)
as it came out.** Moving a threshold after seeing the number it produced is how a
test stops meaning anything. Fixing an experiment that cannot tell signal from
noise is a different thing, and the distinction is worth keeping clear.

## Cost

This spike runs under a **profile**, and the profile costs more than the model
does. `realistic` is the default because the numbers here are used as forecasts,
and a forecast taken from an empty session is a floor.

- **`realistic`** carries what a resident agent actually carries: its own persona,
  a six-tool memory surface with full descriptions, read-only file tools, the
  user's setting sources, session persistence, and a ~2,500-token
  retrieved-memory block on every turn. About $0.20 per turn on sonnet.
- **`minimal`** is the comparison: no tools, no setting sources, no persistence,
  a five-word prompt. About $0.009 per turn on haiku. Useful for isolating what
  the profile costs; **not** a number to design against.

Either way the harness is built to waste nothing: `startup()` answers the memory
question without sending a prompt at all, the turn count is fixed by `ROUNDS`
rather than by the roster size, and every session carries hard `maxTurns` and
`maxBudgetUsd` caps. The harness prints what it actually spent at the end, so the
estimate is replaced by a fact.

## Running it

```bash
cd spikes/0003-concurrent-sessions
pnpm install
pnpm start                             # realistic profile, sonnet
PROFILE=minimal MODEL=haiku pnpm start # the cheap comparison
```

Claude Code must be installed and logged in on the machine you run this on. The
harness uses whatever account that installation is authenticated with — it never
handles credentials itself.

To try a smaller or larger roster:

```bash
SESSIONS=3 pnpm start
```

Paste the whole output. The summary block is the result; the environment lines
are what make it re-checkable later.
