# 0003. MIT licence

**Status:** Accepted
**Date:** 2026-08-10

## Context

The project is public from the first commit and there is no monetisation plan.
Three licences were realistic.

**MIT** is short, permissive, and universally understood. **Apache-2.0** is
equally permissive but adds an explicit patent grant and a `NOTICE` requirement,
which is why corporate legal teams often wave it through without review.
**AGPL-3.0** is copyleft and would force anyone offering a modified version over
a network to publish their changes.

One premise worth correcting, because it was part of the discussion: MIT is not
"less liability" than Apache-2.0. Both disclaim warranty and liability in
equivalent terms. The real difference is the patent grant and the `NOTICE`
obligation, not exposure.

## Decision

**MIT.**

## Consequences

- Anyone may use, modify, and redistribute this, including commercially, with
  attribution.
- There is **no explicit patent grant**. For a project of this kind — an
  orchestration harness with no novel algorithms — that is a small exposure, but
  it is a real difference from Apache-2.0 and is recorded here rather than
  glossed over.
- Every dependency must be MIT-compatible. **AGPL, SSPL, and source-available
  licences are disqualifying**, and `scripts/check-licenses.mjs` fails the build
  on one rather than trusting anyone to check by hand.
- A `NOTICE` file exists anyway, because the trademark position in
  [0002](0002-project-name.md) needs somewhere to live.

## Alternatives considered

**Apache-2.0.** Recommended initially, for the patent grant and for how readily
corporate legal accepts it. Rejected by the maintainer, who wanted the simpler
licence. A defensible call: the patent grant matters most for projects
implementing patentable techniques, which this is not.

**AGPL-3.0.** Rejected. Copyleft solves a problem this project does not have —
there is nothing to protect from a hosted competitor when there is nothing being
sold — and it deters exactly the contributors an early project needs.

## Revisit when

Never, in practice. Relicensing a project with outside contributions requires
every contributor's agreement, which is why this decision is effectively
permanent and was worth getting right at commit zero.
