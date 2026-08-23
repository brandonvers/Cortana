# 0001. Run on the user's own subscription, behind a port

**Status:** Accepted
**Date:** 2026-08-10

## Context

Agents need a model. There are two ways to get one, and they are not
interchangeable.

A **metered API key** is billed per token, has published limits, and is
unambiguously permitted for building products. A **consumer subscription** is
flat-rate, already paid for by many of the people who would want to run this, and
comes with an agent loop, tool surface, permission system, and sandbox already
built.

The relevant provider's policy on the second option moved twice in 2026: use by
third-party harnesses was prohibited in April, then permitted again in June under
a metered credit scheme, which was itself paused before taking effect. The
current documented position distinguishes between two things:

- **Prohibited:** a developer offering their product's users a "log in with your
  provider account" flow, or routing other people's requests through subscription
  credentials. That is a service built on someone else's plan.
- **Metered and acknowledged:** a person running a self-hosted third-party tool
  on their own machine, against their own already-authenticated installation, on
  their own plan.

This project is unambiguously the second shape. But "unambiguously the second
shape today" is not a durable foundation when the line has moved twice in five
months.

## Decision

**Agents run on the user's own subscription, through the provider's own locally
installed tooling, which the user authenticates themselves.**

The project never handles provider credentials, never offers a login flow, and
never proxies anyone's requests.

**And everything that touches the provider lives behind a single `ModelRunner`
port.** Exactly one package may import provider types, and CI enforces it.

> Enforced since 2026-08-23 by `scripts/check-boundaries.mjs`, which pins each
> provider module to the one package permitted to import it — declaring the
> dependency counts as importing it — and verifies its own detector against
> fixtures on every run, because with no runner package written yet the rule is
> trivially satisfied and a broken check would pass silently.

## Consequences

- Users pay nothing beyond a subscription they already have.
- We inherit a mature agent loop, permission system, and sandbox instead of
  building them.
- **We are exposed to policy risk we do not control.** The port is the mitigation:
  if the terms change, one adapter is rewritten and the other twelve packages do
  not notice.
- The port must be designed for the *lower* common denominator. Provider-specific
  conveniences live inside the adapter and are simply absent under another one.
- A second adapter is expected eventually, for deterministic tests if nothing
  else. Contract tests against recorded fixtures make the port real rather than
  aspirational.

## Alternatives considered

**Metered API key only.** Clean legally, versioned, trivially mockable. Rejected
because it changes the product: a flat-rate personal assistant that talks all day
becomes a bill that grows with use, and the agent loop would have to be built
from scratch.

**Subscription only, no port.** Simpler, less code. Rejected because it bets the
whole project on a policy that has already changed twice, and because it makes
deterministic testing impossible.

**Ask the provider for an exception.** Not available to a single-maintainer
non-commercial project, and the answer would not bind their future policy anyway.

## Revisit when

The provider's terms change in either direction, or when a second adapter has
been used in anger and the port's shape can be judged against reality rather than
against one implementation.
