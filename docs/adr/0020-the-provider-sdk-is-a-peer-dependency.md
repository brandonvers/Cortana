# 0020. The provider SDK is a peer dependency the user installs

**Status:** Accepted
**Date:** 2026-09-01

## Context

M2 needs the provider's SDK, and reading its licence before adding it turned up a
conflict between two rules this project has already written down.

The licence, in full, is one sentence:

> © Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements
> outlined here: <https://code.claude.com/docs/en/legal-and-compliance>

That is proprietary — not open source, and stricter than the source-available
licences named in [CONTRIBUTING.md](../../CONTRIBUTING.md), which says a
dependency's licence "must be compatible with MIT" and that "AGPL, SSPL, and
source-available licences are **disqualifying**". By the letter of that rule the
SDK cannot be a dependency.

By [ADR-0001](0001-model-access-behind-a-port.md) it also cannot be absent. That
decision is the shape of the whole product: agents run "on the user's own
subscription, through the provider's own locally installed tooling, which the
user authenticates themselves". There is no version of this project that does not
reach the provider, and `check:licenses` would fail the build on the attempt.

Two things resolve it, and only the second is decisive.

**The MIT claim is about our source, and stays true.** The rule exists because
"this project is redistributed as source under MIT, and a copyleft or
source-available dependency in the tree makes that claim false". We do not
redistribute the SDK: it is installed from the provider's own registry entry,
under terms the installer accepts.

That argument alone would also permit an ordinary dependency, and it should not.
**A user pulling in proprietary code should be doing it deliberately.** As a plain
dependency, `pnpm install` acquires Anthropic's terms on their behalf as a
transitive consequence of installing something else. That is the part worth
fixing, and ADR-0001 already describes the shape that fixes it: the provider's
tooling is *theirs*, locally installed, authenticated by them.

## Decision

**The provider SDK is an optional peer dependency, declared in
`@cortana/runner-claude` and installed by the user.**

- `peerDependencies` with `peerDependenciesMeta.optional`, so nothing installs it
  on the user's behalf.
- Also a `devDependency` of that one package, so the adapter typechecks and its
  tests run here and in CI. A development dependency is not redistributed and not
  acquired by a user.
- The setup documentation states the step and why it exists, rather than treating
  it as an inconvenience to be smoothed over.
- `check:licenses` acknowledges it by name, with this ADR as the reason, in the
  same mechanism that already records accepted copyleft. An exception that is not
  written where the rule is enforced is not an exception; it is a gap.

## Consequences

- **`pnpm install` alone does not produce a working runner**, and that is now a
  documented step rather than a confusing failure. It is less friction than it
  sounds: the user must already install the provider's CLI and authenticate it,
  so the setup they are being asked for is one they were doing anyway.
- **Accepting the provider's terms is the user's act.** They install the SDK, from
  the provider, under an agreement between the two of them. This project is not a
  party to it, which is exactly what ADR-0001 says it is not.
- **The dependency tree this project ships implies no proprietary code.** A
  reader of `pnpm-lock.yaml` sees what a user actually gets.
- **The kernel must handle the SDK being absent** as a real state, with a message
  naming the missing package and the reason, rather than an `ERR_MODULE_NOT_FOUND`
  stack trace. That is a small amount of work M1's error taxonomy already covers.
- **The exception is narrow and named.** One package, one dependency, one reason.
  Any other proprietary dependency is still disqualified by the unmodified rule.
- If the provider's terms change in a way this project cannot live with, the
  answer is unchanged from ADR-0001: one adapter is rewritten. Now it is also one
  line of `package.json`.

## Alternatives considered

**An ordinary dependency, with an exception in the licence check.** Simplest, and
works out of the box. Rejected for the reason above: it acquires proprietary
terms on the user's behalf as a side effect of installing something else, and the
convenience is not worth making that decision for them.

**An optional dependency.** Installs when it can, skips silently when it cannot.
Rejected for muddling both positions: the user still does not decide, and the
failure moves from install time to run time.

**Talking to the provider's CLI over its own protocol, with no SDK at all.** No
npm dependency and no licence question. Rejected because
[ADR-0004](0004-own-the-orchestration-layer.md) already decided which layer this
project implements and which it adopts, and the SDK is squarely in the adopted
half. Reimplementing it is the work that decision declined, and it would still be
running the same proprietary program.

## Revisit when

The provider publishes the SDK under a licence that permits redistribution, at
which point the peer arrangement stops buying anything and an ordinary dependency
is simpler. Or the terms change such that a user installing it is no longer a
decision this project should stay out of.
