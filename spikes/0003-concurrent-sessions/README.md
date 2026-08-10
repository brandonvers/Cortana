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
| 2 | Resident memory per session | measured; total must leave ample headroom on the target machine |
| 3 | Warm turn latency vs cold start | warm < 40% of cold |
| 4 | Pre-warmed wake, prompt to first token | **< 3 s** |
| 5 | Pre-warming is worth its complexity | pre-warmed measurably faster than cold |
| 6 | Cost | measured and reported, so the budget governor has real numbers |

## Cost

The harness is built to answer the questions above for as close to nothing as
possible:

- **A short custom system prompt**, not the full agent preset. This is also what
  a real Cortana agent uses — each agent carries its own prompt — so it is
  realistic rather than a cheat.
- **No tools loaded.** Tool definitions dominate a default system prompt, and this
  spike measures process and session behaviour, not tool use.
- **No settings sources.** Your `CLAUDE.md` and project settings are not loaded,
  which keeps the measurement clean and the prompt small.
- **The cheapest model**, and prompts that are a few tokens long.
- **Hard caps**: `maxTurns` and `maxBudgetUsd` on every session.

The total is a handful of very small turns. The harness prints what it actually
spent at the end, so the estimate is replaced by a fact.

## Running it

```bash
cd spikes/0003-concurrent-sessions
pnpm install
pnpm start
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
