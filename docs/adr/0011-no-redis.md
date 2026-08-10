# 0011. No Redis; the queue is SQLite and the bus is in-process

**Status:** Accepted
**Date:** 2026-08-10

## Context

Redis is the reflex answer for queues, pub/sub, and caching in a system with
background work. It was raised as a candidate.

It solves three problems: **shared state between processes**, **pub/sub across
machines**, and **queueing at high throughput**. This system has one process on
one machine serving one person, and the work it queues is measured in jobs per
minute, not per millisecond.

There is also a licence dimension. Redis moved from BSD to a dual
source-available licence in 2024 and later added AGPLv3 as a third option.
**Valkey** is the BSD-3 fork maintained under the Linux Foundation, and it is what
current Debian and Ubuntu releases ship by default.

## Decision

**No Redis, and no equivalent.**

- The **durable queue is a SQLite table** with leases, attempt counts, backoff,
  and idempotency keys — in the same transaction as the state the job mutates.
- The **event bus is in-process and typed** — no serialisation, no network hop,
  and a compile-time contract between publisher and subscriber.

## Consequences

- **One process to install, one to supervise, one to back up.** A stranger gets
  from clone to running system without provisioning a datastore, which is a
  requirement rather than a nicety for a self-hosted project.
- Enqueueing a job and updating the state that caused it happen in **one
  transaction**. With an external queue that is two systems that can disagree
  after a crash, and reconciling them is work that now does not exist.
- Bus messages are typed values, not JSON that has to be parsed and validated at
  every boundary.
- **We give up horizontal scaling**, which is not a goal, and cross-process
  pub/sub, which becomes relevant only if a second execution node ever exists.
- SQLite's single-writer model must be respected by construction — one serialised
  writer queue in the kernel — rather than hoped for.

## Alternatives considered

**Redis or Valkey for the queue.** Rejected: it solves problems this system does
not have, at the cost of a service every user must run.

**A job library backed by Redis.** Same objection, plus a dependency whose whole
value is the thing we are declining.

**An external message broker.** Rejected for the same reason, more so.

## Revisit when

A second execution node exists — the plausible case being a machine on a different
operating system running platform-specific work. At that point cross-process
messaging becomes a real requirement rather than a speculative one, and the choice
should be **Valkey**, on the BSD-3 licence, for compatibility with this project's
MIT terms.
