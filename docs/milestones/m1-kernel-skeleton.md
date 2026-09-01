# M1 — the kernel skeleton

**Status:** Done — every item verified
**Date:** 2026-08-23
**Version target:** `0.1.0-alpha` → `0.1.0`

---

## What M1 is

The first production code in this repository. Everything before it was a spike,
thrown away on purpose. Two things change with that:

- **Dependencies become permanent** until they are deliberately removed, so each
  one is a decision under [CONTRIBUTING § Dependencies](../../CONTRIBUTING.md)
  rather than something a spike pinned and forgot.
- **The package boundaries decided here are inherited by every later milestone.**
  Moving a boundary in M5 costs more than choosing it now, and the boundary that
  matters most — [ADR-0001](../adr/0001-model-access-behind-a-port.md)'s single
  provider port — has no enforcement in CI as this plan is written, despite the
  ADR saying it does. Step 0 below closes that.

M1 builds no capability a user can see. That is what it is for. It builds the
thing every later milestone stands on: a process that starts, holds durable
state, writes to it safely, says what it did, and stops without losing anything.

## Definition of done

[RELEASING §2](../RELEASING.md) makes this a gate rather than a summary, so it is
written before the work instead of after it.

- [x] The daemon starts on a machine with no configuration, and either runs on
      defaults or **exits naming the setting that is missing** — never a stack
      trace
- [x] Migrations apply at boot; running them twice is a no-op; a database written
      by a newer build is **refused rather than half-migrated**
- [x] Every write goes through one serialised writer, and **concurrent callers
      are exercised by a test** — which [spike 0005](../spikes/0005-durable-bus.md)
      explicitly did not do
- [x] `SIGTERM` drains and exits `0` within a bounded time. `SIGKILL` loses
      nothing that was acknowledged, **proven by a test that kills a real child
      process and reopens the file** — not by assertion
- [x] Logs are structured and levelled, and **a secret placed in configuration
      never appears in one**, verified by a test rather than by review
- [x] The secret store **reports at boot which mechanism it is using**, so a
      degraded fallback is never silent
- [x] A systemd unit installs, starts on boot, and restarts on failure
- [x] **CI enforces the provider boundary** — step 0
- [x] CI green on `ubuntu-latest` and `macos-latest`, with the native module
      building on both

### What the last one cost, and what it taught

"Installs, starts on boot, restarts on failure" is a claim about a machine, so it
was measured on the Debian server on **2026-09-01** rather than asserted here.
It holds: the unit starts, survives a reboot, and comes back from a `SIGKILL`
with `NRestarts=1`. The `instances` table read afterwards is the clearest summary
of the whole milestone —

```text
08:42:30 -> 08:42:37   clean stop
08:42:38 -> NULL       killed with SIGKILL; still null, and always will be
08:47:10 -> 09:01:08   ran until the reboot, which stops services with SIGTERM
09:02:14 -> NULL       the run that came up after it
```

— because `stoppedAt` means exactly what it was designed to mean, on real
hardware, with a real kill.

**Two of the steps were discovered by the service failing**, and both belong to
M7 rather than here:

- **Where Node comes from.** A version manager keeps it under `$HOME`, which
  `ProtectHome=yes` hides from the service; the failure is `env: 'node': No such
  file or directory`, which reads like a PATH problem and is not one. Debian 13's
  own package is too old for the type stripping that
  [ADR-0009](../adr/0009-typescript-7-type-stripping.md) relies on. It was worked
  around by copying a known-good Node to
  `/opt/node`, which gets no security updates — fine for a verification, not for a
  release.
- **What reaches the target.** Copying a checkout is not enough: the first
  attempt failed with `Cannot find package '@cortana/config'`, because the source
  had never had an install run in it. Deployment currently requires a full
  `pnpm install` on the machine, development dependencies and native build
  included, which is more than a self-hosted project should ask of a stranger.

Two settings are worth knowing before repeating it. `TimeoutStopSec=45` has to
stay above the daemon's own shutdown deadline, or the graceful path is
unreachable. And `MemoryDenyWriteExecute=yes` is deliberately absent: it is on
every hardening checklist and stops Node from starting, because V8 compiles to
machine code at runtime.

## The packages

```text
                    ┌──────────┐
                    │   core   │   no dependencies, internal or external
                    └────┬─────┘
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
     ┌────────┐    ┌──────────┐    ┌────────┐
     │ config │───▶│ storage  │    │  bus   │
     └────┬───┘    └────┬─────┘    └───┬────┘
          └─────────────┼──────────────┘
                        ▼
                   ┌─────────┐
                   │ kernel  │   a library: no signals, no process
                   └────┬────┘
                        ▼
                   ┌─────────┐
                   │ daemon  │   the process, and the service unit
                   └─────────┘
```

| Package | Owns | Depends on |
|---|---|---|
| `@cortana/core` | Product identity, `TrustLevel`, identifier types, the clock port, the error taxonomy. **No runtime dependencies at all** | — |
| `@cortana/config` | The configuration schema, file and environment loading, boot validation, and the `Secret` type | `core` |
| `@cortana/storage` | Opening the database, PRAGMAs, the Drizzle schema, migrations, and the single serialised writer | `core`, `config` |
| `@cortana/bus` | The in-process typed event bus of [ADR-0011](../adr/0011-no-redis.md) — publisher and subscriber typed against each other at compile time | `core` |
| `@cortana/kernel` | Start order, health, supervision, graceful shutdown — as a library with no opinion about processes | `core`, `config`, `storage`, `bus` |
| `@cortana/daemon` | The process: entry point, signal wiring, log destination, service unit | all of the above |

### Why six, and not one

Three of the splits are load-bearing rather than tidy:

- **`core` has no dependencies so that everything can depend on it.**
  [ADR-0002](../adr/0002-project-name.md) requires the product name to live in
  exactly one place, and that place has to be importable from every package —
  including ones a third party writes.
- **`bus` is separate because modules subscribe to it.** A module that wants an
  event should not have to import the kernel to get the type of that event.
- **`kernel` is separate from `daemon` because a supervision tree that installs
  its own signal handlers cannot be tested.** That split is what turns "graceful
  shutdown" from something verified by hand into a claim a test can make.

`config` and `storage` could reasonably be one package. They are two because
[CONCEPTS §5](../CONCEPTS.md) gives every module "a configuration schema,
validated at boot" — so the configuration types are part of the module interface,
and the module interface should not drag a native SQLite driver in behind it.

### One naming detail

The binary name is a literal string in `package.json`'s `bin` field, which makes
it a second site that hard-codes the product name. ADR-0002's mitigation is that
renaming stays cheap, so this belongs on the same short list as `PACKAGE_SCOPE`
rather than being discovered during a rename.

## The order of work

Each numbered step is one pull request and ends with `main` green.

**0. The boundary check, before there is anything to check.**

ADR-0001 says "exactly one package may import provider types, and CI enforces
it". **CI does not.** No such check exists, and the claim has been in an accepted
ADR since 2026-08-10.

It goes in first, while the cost is a script rather than a refactor: a
`check:boundaries` script that fails the build if any package outside
`runner-*` imports `@anthropic-ai/claude-agent-sdk` or `@anthropic-ai/claude-code`.
This is also the cheapest moment in the project's life to write it — with no
runner package yet, the rule is trivially satisfied, so the check can be
validated by deliberately breaking it and watching it fail.

**1. `core`** grows by the smallest amount the later steps need: branded
identifier types, an error taxonomy, and a `Clock` port so that nothing calls
`Date.now()` directly.

The clock deserves an honest note. M1 has only three time-dependent behaviours —
the shutdown deadline, migration bookkeeping, and log timestamps — which is thin
justification for an abstraction. It is included because leases and backoff in M6
need it, and retrofitting it then touches every package, while adding it now
costs about ten lines in the package that has no dependencies. **If M6 arrives
and it has not earned its place, it should be deleted rather than kept.**

**2. `config`** — schema and loading, before storage, because the database path,
the PRAGMA choices, and the log level are all configuration.

**3. `storage`, in two parts.** First open, PRAGMAs, and migrations, which a test
can prove against a temporary file. Then the writer queue, which is the harder
half and which carries the debt spike 0005 named:

> **One writer.** The design mandates a single serialised writer, so contention
> was not exercised. It should be, once the kernel's writer queue exists.

**4. `bus`** — small, and depends only on `core`. It could come earlier. It comes
here because the *durable* half of what spike 0005 called "the bus" lives in
`storage`, and building them in this order keeps that split explicit instead of
discovering it later.

**5. `kernel`** — start order, health, and shutdown. This is where the ordering
constraints become code: the writer drains before the database closes, the
database closes before the logger flushes, and the process exits after that.

**6. `daemon`** — entry point, signal wiring, unit file. Last, because it is the
thinnest layer and everything it wires must already work without it.

**7. The crash test, promoted from a spike.** Spike 0005's kill test becomes a
real test in this repository. It is the only way *durable before acknowledged*
is a fact about this codebase rather than about a spike that was deleted.

## What the spikes already settle

M1 does not have to rediscover any of this.

| Question M1 would otherwise face | Settled by | What it hands M1 |
|---|---|---|
| Does the migration tool work under TypeScript 7? | [0001](../spikes/0001-drizzle-kit-typescript-7.md) | Yes. `drizzle-kit` bundles esbuild and never touches the compiler API, so the missing 7.0 API is irrelevant |
| Is *durable before acknowledged* real under `SIGKILL`? | [0005](../spikes/0005-durable-bus.md) | Yes, on ext4 and APFS. Four kills each, zero acknowledged writes lost, zero torn payloads. Leases reclaimed at boot, redelivery idempotent |
| Is durability worth its cost? | [0005](../spikes/0005-durable-bus.md) | The bus cost **1.1 ms against an 11,198 ms model turn**. There is no latency budget to defend, so durability settings are chosen for safety |
| Do the report delivery rules work against a real store? | [0005](../spikes/0005-durable-bus.md) | Yes — [ADR-0014](../adr/0014-kernel-mediated-reports.md)'s three rules behaved as written. **M3 work**, but it constrains the storage shape M1 lays down |
| How much memory does a resident session cost? | [0003](../spikes/0003-concurrent-sessions.md) | 263–264 MB idle, flat across scale. A sizing input for the supervisor, not code M1 writes |
| How many vectors before search misses its budget? | [0002](../spikes/0002-sqlite-vec-fts5-multilingual.md) | ~65,000 at 50 ms. **M5**, and deliberately untouched here — see below |

## The four decisions M1 could not avoid

All four were taken on **2026-08-23**. Two of them outlive the milestone and are
recorded as ADRs, so the reasoning is not repeated here.

### 1. `synchronous = FULL` — [ADR-0017](../adr/0017-durability-over-throughput.md)

[Spike 0005](../spikes/0005-durable-bus.md) measured durability at `FULL` and
explicitly refused to generalise from it, leaving the choice to a person. It is
`FULL`: the same spike measured the bus at **1.1 ms against an 11,198 ms model
turn**, so there is no latency budget for the speed to buy anything for. More
generally — where a storage setting trades durability for throughput, this
project takes durability, and reversing that needs a measurement rather than an
argument.

### 2. Secrets are sealed by the OS — [ADR-0018](../adr/0018-secrets-at-rest.md)

A four-rung ladder behind one `SecretStore` port — `systemd-creds` sealed to TPM2,
`systemd-creds` with a host key, the macOS Keychain, and an unencrypted `0600`
file — **discovered at runtime, never configured**, with every rung below the
first announced at boot. No npm dependency. Separately and unconditionally: a
`Secret` type whose value cannot reach a log line, an audit record, or an error
message.

**The precondition was checked, and the answer changes what M1 exercises.**
`/dev/tpmrm0` is absent on the server, so the primary deployment runs on rung 2:
encrypted with a root-only host key held separately from the ciphertext, and
decrypted by systemd into a tmpfs — better than a config file, but **not sealed**,
and the ADR forbids describing it as such.

That makes rung 1 the one M1 cannot exercise on any machine it has access to,
including CI. It therefore needs a fake at the port boundary rather than trust
that it works first time on hardware nobody here owns.

### 3. Migrations are forward-guaranteed from the first beta

Recorded in [RELEASING's stage table](../RELEASING.md). An alpha is explicitly
"the maintainer, and nobody else", so a guarantee that binds only against one's
own database is ceremony. Beta is where RELEASING already requires migrations to
"exist and are tested", and where someone else's data first appears.

**What it costs M1 is not nothing, even though M1 ships an alpha.** The mechanism
has to be built for the guarantee from the start: a tool that refuses a
destructive migration unless it is explicitly marked is far cheaper to write
before there are migrations than after.

### 4. Six packages, and only one of the two queues

The package graph above is the decision. It stays in this plan rather than
becoming an ADR for one reason: an ADR restating that table would be a second
copy of it, and this project has already been bitten by a claim living in four
places and being corrected in one.

The second half is a scoping call. RELEASING lists "writer queue" under M1 and
"durable jobs" under M6; those are two different queues and the words are close
enough to cause the mistake once. **The writer queue serialises SQLite writes.
The job queue is leases, attempts, backoff, and idempotency keys.** M1 ships the
first, the migration mechanism, and only the tables M1 itself uses. The job
tables arrive in M6 as a migration — which is a better test of the migration
mechanism than seeding it with a schema nobody is using yet.

## Where this touches the retrieval question that is still open

[ADR-0012](../adr/0012-local-embeddings.md) records the coupling in one line —
"the dimension is **1024**, and it is a parameter rather than a constant
everywhere it appears" — and [the outstanding list](../spikes/README.md#outstanding)
records why it is still live: the private corpus can overturn `bge-m3`, and a
different model changes the number.

The recommendation above satisfies that **by construction rather than by
discipline**: M1 creates no vector table, no embedding column, and does not load
`sqlite-vec`. There is no dimension to hard-code, so the constraint cannot be
violated by forgetting it.

Two things M1 still owes the memory work:

- **The open path needs a hook for loading an extension before migrations run**,
  because a `vec0` virtual table cannot be created without `sqlite-vec` loaded.
  That is a hook, not a schema.
- **The configuration schema must not require an embedding model name.**
  Requiring one would settle, in M1, the question the private corpus exists to
  answer. If it appears at all, it appears in M5.

## What M1 does not build

Named so that scope creep has to be a decision rather than a drift.

| Not in M1 | Where it belongs |
|---|---|
| The `ModelRunner` port and its adapter | M2 — M1 only enforces the boundary it will live behind |
| The audit pipeline and cost tracking | M2 |
| Chat, the conversation loop, approvals, the policy engine | M3 |
| Memory schema, embeddings, retrieval | M5 |
| Scheduler, durable jobs, the proactive gate, budget governor | M6 |
| Dashboard, ops CLI, a second runner adapter, packaging | M7 |
| The module host's supervision of third-party code | M7 — the failure boundary in [ADR-0013](../adr/0013-module-isolation.md) needs modules to exist |
| A Dockerfile | Nowhere. Container deployment is not the primary path |
| A launchd plist | Deferred. macOS is the development machine, where the daemon runs from a terminal; the systemd unit is the one a deployment needs |

## Dependencies

Each needs a decision before it is added. Versions and licences checked
**2026-08-23**.

| Package | Version | Licence | For |
|---|---|---|---|
| `better-sqlite3` | 13.0.3 | MIT | The driver. Decided in [ADR-0010](../adr/0010-sqlite-storage.md), exercised in spikes 0001, 0002 and 0005 on both targets |
| `@types/better-sqlite3` | 9.6.0 | MIT | The package ships no types. DefinitelyTyped, `devDependency` only |
| `drizzle-orm` | 0.45.2 | **Apache-2.0** | The query layer. Permissive, not copyleft; the patent grant and attribution obligation are satisfied by the existing `NOTICE` |
| `drizzle-kit` | 0.31.10 | MIT | Migrations. Verified against TypeScript 7 in spike 0001 |
| `zod` | 4.4.3 | MIT | Schema validation. Already required by [ADR-0015](../adr/0015-structured-output-at-the-model-boundary.md) at the model boundary; M1 reuses it for configuration rather than adding a second validator |
| `pino` | 10.3.1 | MIT | Structured logging. Its `redact` option makes the secret requirement a mechanism rather than a convention |

**Two of these are new decisions in substance.** `zod` is implied by an accepted
ADR but has never been installed. `pino` has not been discussed at all — the
alternative is writing a structured logger, which CONTRIBUTING's rule against
hand-rolling what a maintained standard solves argues against.

Considered and **not** adopted:

- **`sqlite-vec`** — decided in ADR-0010, belongs to M5. M1 loads no extension.
- **`pino-pretty`** — development ergonomics; it can wait until someone is
  annoyed enough to ask.
- **A UUID library** — `crypto.randomUUID()` is in the standard library.
- **A cron parser** — M6, and it is exactly the kind of thing CONTRIBUTING says
  not to hand-roll when the time comes.

### One build-system consequence

`pnpm-workspace.yaml` carries `allowBuilds: {}`, which blocks every dependency's
build script by default. `better-sqlite3` is a native module and will need an
explicit entry. That entry is a decision to execute a dependency's build script,
which is precisely what the empty map exists to force someone to make on purpose.

## Risks

- **The native module is the only thing here that can break one platform and not
  the other.** `better-sqlite3` must build on Linux x86_64 and macOS arm64. Both
  have prebuilt binaries and both are in CI from the first `storage` commit, so a
  broken platform surfaces on the pull request that causes it.
- **Supervision is where a project of this shape usually rots.** ADR-0013 is
  honest about the limit: in-process isolation does not survive a segfault or an
  OOM kill. M1's answer is not to prevent crashes but to make restarting cheap —
  which is only true if the crash test is real, which is why it is step 7 and not
  a follow-up.
- **The boundary check is worth only as much as its coverage.** A check that
  matches import specifiers will not catch a transitive re-export through another
  package. Starting narrow and honest beats a check that is trusted beyond what
  it inspects.
