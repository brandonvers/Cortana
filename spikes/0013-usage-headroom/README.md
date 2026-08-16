# Spike 0013 — Can the budget governor see the wall before it hits it?

**⚠️ Consumes AI usage,** deliberately but modestly: a handful of `sonnet` turns
to move the meter, not enough to exhaust anything.

The outstanding list has carried this row since the beginning:

> **Provider usage-limit behaviour under load** — the budget governor cannot be
> designed against a guess.

It was left last because the obvious way to answer it is to **exhaust the
subscription's limit and watch what breaks**. That is a different category of
cost from every other spike here: it would lock the operator out of Claude Code
for the rest of the window, including whatever they were doing at the time.

Reading the SDK first turns out to remove the need.

## What the typings already give away

The Query interface exposes a method whose name is its own stability warning:

```ts
usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET():
  Promise<SDKControlGetUsageResponse>
```

It returns session cost **and** `rate_limits`, with per-window `utilization`
(0–100) and an ISO `resets_at`, for the `five_hour`, `seven_day`,
`seven_day_opus` and `seven_day_sonnet` windows. `rate_limits_available` is
documented as *"false when plan rate limits do not apply (API key, Bedrock,
Vertex …)"* — so on a Pro or Max subscription, which is what this project
targets, it should be true.

There is also a push channel, `SDKRateLimitEvent`, carrying
`status: 'allowed' | 'allowed_warning' | 'rejected'`, `utilization`, `resetsAt`
and `rateLimitType`.

**If those numbers are live and fine-grained, the governor never needs to
approach the limit at all** — it can steer on utilization and reset times. If
they are stale, coarse, or absent, that is equally decisive and worth knowing
before a governor is designed around them.

## Pass criteria, stated before running

| # | Criterion | Threshold |
|---|---|---|
| E0 | **The telemetry exists on this account** | `rate_limits_available` is true, and `subscription_type` is reported |
| E1 | **The windows carry usable numbers** | `utilization` is numeric and `resets_at` parses as a date, for at least `five_hour` |
| E2 | **Utilization moves after known work** | the decisive one: a measurable change after several real turns |
| E3 | **The reset time is consistent** | `resets_at` does not jump around between reads within one run |
| E4 | **The push channel fires** | recorded: does a `rate_limit_event` arrive in an ordinary session, and with what `status`? |
| E5 | **Session cost agrees with the result messages** | the usage endpoint's cost and the summed `total_cost_usd` should not disagree wildly |

**E2 is the criterion that decides whether a governor can exist in this form.** A
number that does not move after real work cannot be steered on, and the honest
answer would be that the governor needs a different signal — its own accounting
from `total_cost_usd`, which spike 0009 measured swinging 34× on prompt-cache
state alone.

**E4 may legitimately produce nothing.** The event is documented as emitted
"when rate limit info changes", and in a short run at low utilization it may
never fire. That is recorded as *not observed*, never as *does not work*.

### The expected result, written down before the run

`utilization` is a percentage of a five-hour window. A handful of turns on a Max
plan may well move it by **less than one percentage point**, in which case E2
fails on granularity rather than on staleness — and the report must distinguish
those two, because they imply different designs. A stale number means the
governor cannot trust the reading; a coarse one means it cannot steer finely but
can still refuse to start expensive work near the wall.

## What this deliberately does not do

**It does not exhaust the limit.** Nothing here establishes what the kernel sees
at the wall. The typings say an assistant message can carry
`error: 'rate_limit'` and that `SDKRateLimitInfo.status` can be `'rejected'`;
both are recorded as **documented, not measured**, and that gap stays open in the
report rather than being quietly closed.

That is a deliberate scope cut, not an oversight: the measurement would cost the
operator their working window, and everything the governor actually needs to
*avoid* the wall is measurable without touching it.

## Running it

```bash
cd spikes/0013-usage-headroom
pnpm install
pnpm start
```

`TURNS=6 pnpm start` to push harder at E2 if the first run shows no movement.
