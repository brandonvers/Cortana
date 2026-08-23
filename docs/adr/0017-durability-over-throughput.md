# 0017. `synchronous = FULL`, and durability is not traded for speed

**Status:** Accepted
**Date:** 2026-08-23

## Context

[ADR-0010](0010-sqlite-storage.md) chose SQLite in WAL mode and
[ADR-0011](0011-no-redis.md) made that database the durable queue, so every
resilience claim in this project reduces to one SQLite setting.

`synchronous` decides when SQLite waits for the operating system to confirm a
write reached the disk. In WAL mode:

- **`FULL`** fsyncs the write-ahead log on every commit.
- **`NORMAL`** syncs at checkpoints. Faster, and at most the last transaction is
  lost — on **power loss or a kernel panic**, not on a process crash.

[Spike 0005](../spikes/0005-durable-bus.md) measured durability at `FULL` and
explicitly declined to generalise from it:

> Production will likely want `NORMAL`, which is sufficient for *process* crashes
> — the case actually tested here — but permits losing the last transaction on
> *power* loss. That is a separate decision, and it should be made explicitly
> rather than inherited.

The same spike measured what the setting would be bought with. The bus cost
**1.1 ms against an 11,198 ms model turn** — four orders of magnitude below
inference — and drew the conclusion in the spike's own words: "there is no case
for trading durability away to make the bus faster."

## Decision

**`synchronous = FULL`, in WAL mode, on every connection.**

More generally: **where a storage setting trades durability for throughput, this
project takes durability**, and reversing that requires a measurement showing the
throughput is actually needed — not a plausible argument that it might be.

## Consequences

- **The guarantee covers power loss and kernel panics, not only process
  crashes.** The deployment target is a machine in a home, where an unexpected
  power cut is a real failure mode rather than a data-centre abstraction.
- **What spike 0005 verified is what production runs.** Its four-kills-per-
  platform result described `FULL`; under `NORMAL` the measurement would describe
  a configuration nobody ships, which is the more expensive kind of wrong.
- **A cost, and it is real:** an fsync per commit bounds write throughput to the
  disk's sync rate. At the scale this system operates — jobs per minute, not per
  millisecond ([ADR-0011](0011-no-redis.md)) — that ceiling is far above demand.
  If it ever is not, the fix is a measurement and a new ADR.
- **This does not make the database crash-proof.** Spike 0005 was explicit that
  a kill landing *inside* an fsync is a kernel and hardware guarantee this
  project relies on rather than tests. `FULL` narrows the window; it does not
  close it.
- The setting is applied per connection rather than stored in the file, so it
  belongs in the one place that opens the database and must not be reachable
  from configuration. A user cannot switch it off by accident.

## Alternatives considered

**`NORMAL`.** The common production default, and the one spike 0005 predicted
would be wanted. Rejected because the prediction was about a system with a
latency budget, and the same spike measured that this one does not have one: the
coordination cost is already invisible next to inference.

**Make it configurable.** Rejected. A durability guarantee that a configuration
file can turn off is not a guarantee, and the failure it produces — a lost last
transaction after a power cut, months later — is untraceable to the setting that
caused it.

**`OFF`.** Not seriously considered, and named here only so nobody proposes it as
an optimisation for a test suite. Tests that need speed use an in-memory
database, which is a different mechanism with no durability claim attached.

## Revisit when

A measurement on real workload shows commit latency bounding something a user
notices. The measurement comes first; the setting change follows it.
