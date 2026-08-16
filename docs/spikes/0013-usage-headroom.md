# Spike 0013 — The governor can see the wall, and is warned before it arrives

**Date:** 2026-08-16 · one run
**Verdict:** ✅ **The telemetry exists, is live, and pushes a threshold warning.**
The pre-registered expectation about its granularity was **wrong by an order of
magnitude**, in the useful direction.
**Decides:** what the budget governor reads, and which window binds.

---

## What it does not do, first

**It does not exhaust the limit**, and nothing here establishes what the kernel
sees at the wall. That was the original shape of this row, and it was dropped on
purpose: the measurement would have cost the operator their working window,
including the session doing the measuring.

Reading the SDK removed the need. Everything a governor requires in order to
*avoid* the wall turned out to be readable without approaching it.

## The measurement

```text
before  five_hour  utilization=37   resets_at=2026-08-16T13:59:59.793067+00:00
        seven_day  utilization=87   resets_at=2026-08-18T14:59:59.793087+00:00
                                    subscription=pro   available=true
after   five_hour  utilization=44   resets_at=2026-08-16T14:00:00.232107+00:00
        seven_day  utilization=88   resets_at=2026-08-18T15:00:00.232131+00:00
```

| # | Criterion | Result |
|---|---|---|
| E0 | telemetry present | ✅ `rate_limits_available: true`, `subscription_type: 'pro'` |
| E1 | usable numbers | ✅ utilization and a parseable reset time |
| E2 | **moves after work** | ✅ five-hour **+7 points**, seven-day +1 |
| E3 | reset stable | see below — the criterion was wrong, not the data |
| E4 | **push channel** | ✅ two `rate_limit_event`s, `status: 'allowed_warning'` |
| E5 | cost agreement | not obtained — the harness read the wrong field |

## The prediction was wrong, and that is the finding

The pre-registration said this outright:

> A handful of turns on a Max plan may well move it by **less than one percentage
> point**, in which case E2 fails on granularity rather than on staleness.

It moved **seven points**. The concern the criterion was written around — a
number too coarse to steer on — does not apply. The opposite question does.

**And the seven points are not attributable to this spike.** The account was
running other Claude Code work concurrently while the spike ran, on the same
subscription, and the endpoint reports the account rather than the session. So:
the reading is **live**, which is what E2 asked. The **rate** per turn is not
isolated by this run and should not be quoted as one.

That distinction matters for the governor's design. A live account-wide meter is
exactly what it needs to decide whether to start expensive work. It is *not* a
per-session accounting instrument, and using it as one would attribute other
agents' spend to whichever session happened to read it.

## The best result is the one that was allowed to return nothing

E4 was written expecting silence — "the event may never fire in a short run at
low utilization; that is recorded as *not observed*, never as *does not work*."
It fired twice:

```json
{"status":"allowed_warning","rateLimitType":"seven_day",
 "utilization":0.87,"surpassedThreshold":0.75,"isUsingOverage":false,
 "resetsAt":1787065200}
```

**The provider pushes a warning with the threshold that triggered it.** The
governor does not have to poll and does not have to invent its own thresholds: it
is told when the account crosses one, which window, and when that window resets.

### One trap worth naming

The two APIs report the same quantity on **different scales**. The usage endpoint
gives `utilization: 87`; the pushed event gives `utilization: 0.87`. Anything
consuming both must normalise, and a mistake here is a factor of a hundred in a
governor's arithmetic.

## Which window actually binds

The five-hour window sat at 37% and the seven-day at **87%**, and the warning
that fired was the seven-day one.

**The binding constraint is the weekly window, not the rolling five-hour one.** A
governor watching only the short window would have seen 37% — comfortable — while
the account was two thirds of the way through its threshold on the window that
was about to matter. Both are read; the weekly one is the one that stops work.

## E3 failed on its own definition, not on the data

The criterion compared reset timestamps for **exact equality**. They differed:

```text
13:59:59.793067  ->  14:00:00.232107
```

439 milliseconds, on a five-hour window. That is not a reset time "jumping
around"; it is sub-second drift in how the boundary is computed per request. The
criterion should have carried a tolerance, and reporting this as a failure would
be reporting a defect in the threshold rather than in the thing measured.

**Recorded as: the reset time is stable to within half a second across a run**,
which is well inside anything a governor would act on.

## What this does **not** establish

- **Anything about behaviour at the limit.** The typings say an assistant message
  can carry `error: 'rate_limit'` and that the status can be `'rejected'`. Both
  remain **documented, not observed**, deliberately.
- **A per-turn or per-cost consumption rate.** The account was in concurrent use;
  only liveness was isolated.
- **Anything about Max, Team or Enterprise plans.** `subscription_type` was
  `'pro'`. The windows named in the typings include `seven_day_opus` and
  `seven_day_sonnet`, and neither appeared in this account's payload.
- **That the API will keep existing.** It is called
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`. A kernel reading
  it must treat its absence as a normal state, which is why the harness does.
- **The session-cost field.** E5 returned nothing because the harness looked for
  `session_cost.total_cost_usd` and the payload's shape differs. The result
  messages gave $0.0243 across five turns; the endpoint's own figure is unread.

## Versions

Claude Code **2.1.229** / Agent SDK **0.3.229**, Debian 13, `sonnet`, Node
24.19.0, subscription `pro`. Five turns, **$0.0243**.

## Reproducing it

```bash
cd spikes/0013-usage-headroom
pnpm install
pnpm start          # TURNS=6 to push harder at E2
```

The numbers it prints describe the **account**, not the run. Two people running
this at once will each see the other's usage.
