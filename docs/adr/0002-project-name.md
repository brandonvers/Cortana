# 0002. The project is named Cortana, and renaming must stay cheap

**Status:** Accepted
**Date:** 2026-08-10

## Context

The maintainer wants the project called **Cortana**.

**Cortana is a registered trademark of Microsoft Corporation**, used for a
discontinued virtual assistant and for a character in the Halo video game series.
This project has no connection of any kind to Microsoft Corporation, to Halo, or
to any Microsoft product or service.

Trademark risk is not binary. It scales with commercial use, with market overlap,
and with any impression of endorsement. This project is non-commercial, sold to
nobody, and hosted for nobody. That is a materially different position from a
product competing in the same category — but "materially lower risk" is not
"none", and the risk sits on a public repository that could be asked to rename at
any point.

The maintainer was told this, and chose the name knowing it. That is their call
to make.

## Decision

**The project is named Cortana**, with three mitigations that are requirements,
not suggestions:

1. **The name resolves from exactly one constant.** `PRODUCT_NAME` in
   `@cortana/core` is the only place the string appears in code. No module may
   hard-code it. A test asserts that the package scope stays derived from it, so
   the two cannot drift apart.
2. **No imagery, wordmark, styling, character reference, or anything else that
   could suggest association** with Microsoft or with Halo appears anywhere in
   the project.
3. **A disclaimer of non-affiliation appears in `NOTICE` and in the README**, in
   plain language, near the top rather than buried.

Together these mean a forced rename is a scoped mechanical change — a constant, a
package scope, a repository name — rather than an archaeology project.

## Consequences

- The maintainer gets the name they want.
- A rename, if it ever becomes necessary, is hours rather than days.
- There is a standing constraint on contributors: do not hard-code the product
  name, and do not add themed artwork or references. This is written into
  `CONTRIBUTING.md` for that reason.
- The risk does not disappear. It is accepted, deliberately, with the cost of
  reversal driven as low as it can reasonably go.

## Alternatives considered

**A different name.** Lower risk, and it was recommended. Rejected by the
maintainer, who wants this one and accepts the trade-off. Recorded here so the
decision is visible rather than looking like an oversight.

**The name with no mitigations.** Rejected. Accepting a risk is reasonable;
accepting it while also making it expensive to escape is not.

## Revisit when

Any communication is received from the trademark holder, or if the project ever
takes on a commercial dimension — at which point the calculation changes and this
ADR should be superseded rather than reinterpreted.
