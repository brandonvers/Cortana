# Spike 0010 — Containment for the tools the quarantine agent actually has

**Date:** 2026-08-13 · three runs, plus a settings pass that cost nothing
**Verdict:** ✅ **Answers both remaining sandbox questions, and refutes a claim
this project has been carrying since [ADR-0007](../adr/0007-quarantine-untrusted-content.md).**
**Decides:** where the quarantine profile's second lock actually lives, and the
first measured behaviour of a setting that has been a requirement since
[spike 0004](0004-containment.md).

---

## The claim that does not survive

ADR-0007 and [CONCEPTS §7.3](../CONCEPTS.md) both say it:

> Every security property is enforced by the policy engine **and** by an
> OS-level sandbox. Tool allowlists in frontmatter are ergonomics, never a
> boundary.

Measured, in a single session, on Debian 13 with the sandbox demonstrably
running:

```text
arm            bash    write   read
sandbox-on     no      LANDED  LANDED
  bash said: "/bin/bash: ... Írásvédett fájlrendszer"   <- EROFS, bubblewrap's own
sandbox-off    LANDED  LANDED  LANDED
```

The Bash leg was refused by the filesystem with the same EROFS signature spike
0004 recorded while driving bubblewrap directly. **In that same session, against
that same live sandbox, the in-process `Write` created a file outside the working
directory and the in-process `Read` returned one** — identically to the control
with the sandbox switched off.

**The OS sandbox does not constrain in-process tools.** It contains what it
*spawns*. The quarantine agent has no Bash at all, so for the profile ADR-0007
governs, the second lock was never there.

This was **pre-registered as the expected result** before the run, from the
SDK's own typings — *"in-process tools such as WebFetch are not gated by this
setting"* — precisely so that a confirmation could not be narrated afterwards as
a discovery.

### Why the design does not collapse

Because the second lock exists; it was being looked for in the wrong mechanism.

```text
deny-scoped    Write ERROR: "File is in a directory that is denied by your
                             permission settings."
               Read  ERROR: (the same)
```

A path-scoped `permissions.deny` rule **refused each call individually**, in an
arm otherwise identical to `sandbox-on`. That is a real second layer for
in-process tools, and it is the mechanism the SDK documentation points at all
along: *"Filesystem access: use `Read` and `Edit` permission rules."*

The distinction between the two deny arms matters more than it looks:

| rule form | what happened | what it is |
|---|---|---|
| `Read`, `Write` (bare names) | *"No such tool available: Write. Write is disabled for this session"* | the tool is **removed** — the frontmatter-allowlist layer this project forbids relying on |
| `Read(<dir>/**)`, `Edit(<dir>/**)` | *"File is in a directory that is denied by your permission settings"* | a **per-call policy refusal** — a boundary |

Both "work". Only the second is a security control by this project's own rule.
A spike that had run only the catch-all arm would have reported the forbidden
mechanism as the fix.

## `failIfUnavailable`, measured for the first time

A hard requirement since spike 0004, restated in CONCEPTS, and **never once
observed changing an outcome across two spikes.** Spike 0008 said a working
attempt needed `bwrapPath` delivered through `managedSettings`. Part 0 showed
that channel drops the key; the root-owned file is the one that carries it, and
the gate confirmed delivery before any model call:

```text
resolved: bwrapPath=/nonexistent/bwrap failIfUnavailable=true suppliedBy=file
```

Same broken path, one boolean apart:

| arm | result subtype | tool calls | witness outside cwd | cost |
|---|---|---|---|---|
| missing bwrap, gate **on** | `error_during_execution` | 0 | no | **$0.0000** |
| missing bwrap, gate **off** | `success` | 1 | **LANDED** | $0.0615 |

**The setting does change an outcome, and the outcome it changes is the one that
matters.** With the gate off, a missing sandbox is not an error: the command runs
unsandboxed and the write lands outside the working directory. With it on,
nothing runs at all — the query fails before reaching the model, which is why
that arm cost nothing.

### The asymmetry nobody predicted

The substitute-binary pair behaved differently from the missing-path pair:

| arm | result subtype | witness | substitute binary |
|---|---|---|---|
| shim, gate **on** | `error_max_turns` | no | **EXECUTED** |
| shim, gate **off** | `success` | no | **EXECUTED** |

Two things follow.

**`bwrapPath` is executed, not merely checked.** The marker file proves the
substitute ran. This closes spike 0008's open question, which noted that its own
shim was written executable and so would have satisfied any `access(X_OK)`-style
check without ever being invoked.

**The gate protects against a *missing* sandbox, not a *broken* one.** A binary
that exists counts as available, so the startup gate does not fire; the session
starts and each command fails on its own. That is still fail-closed — no witness
landed on either gate setting — but it is a different failure shape, and only the
missing-binary case is governed by `failIfUnavailable`.

## What changes

### ADR-0007, corrected rather than strengthened

Its existing correction block records the OS leg as **unverified** for the
quarantine profile. It is no longer unverified: it is **measured, and absent**.
The replacement is a `permissions.deny` rule set, which is measured to work.

### CONCEPTS §7.3

"Two layers, always … enforced by the policy engine *and* by an OS-level
sandbox" is false as written. The two layers for an in-process tool are the
policy engine's **allow** decision and its **deny** rules — both inside the
permission engine — with the OS sandbox covering spawned commands only.

`failIfUnavailable: true` moves from "adopted on documented semantics" to
measured. **`allowUnsandboxedCommands: false` does not** — this spike never
exercised it, and it stays adopted on documentation alone.

### The profile generator

- In-process restrictions are **path-scoped `permissions.deny` rules**, never
  bare tool names and never the tool list.
- `failIfUnavailable: true` is load-bearing on hosts where bubblewrap may be
  absent, and its default depends on the channel: **`true` when `enabled: true`
  is passed via the SDK `sandbox` option, `false` from a settings file.** A
  kernel that configures sandboxing through settings files gets the unsafe
  default unless it says otherwise.

## Delivery, settled for free

`resolveSettings()` runs the CLI's merge engine in-process and reports which
tier supplied each value. It costs nothing, and it would have caught spike
0008's central defect on its first run.

| channel | `enabled` | `failIfUnavailable` | `allowUnsandboxedCommands` | `bwrapPath` |
|---|---|---|---|---|
| SDK `managedSettings` | ✅ | ✅ | ✅ | **❌ dropped** |
| root-owned `managed-settings.json` | ✅ | ✅ | ✅ | ✅ (`suppliedBy=file`) |
| `user` / `project` / `local` | ✅ | ✅ | ✅ | ✅ (carried; **not** honoured) |

The pre-registered prediction — that the restrictive-key filter drops a key which
*redirects* rather than *restricts* — held. `bwrapPath` is documented as honoured
only from admin-controlled managed settings, and the SDK's `managedSettings`
option is the one policy channel that drops it. **Spike 0008's recommended fix
for itself was unreachable.**

The `user`/`project`/`local` rows are delivery only. The SDK is explicit that
this API reports *"the raw settings cascade, not a security decision"*, and this
spike did not test whether those tiers are honoured at runtime.

## An observation left open

In the `deny-scoped` arm the Bash step reported **success with no output**, and
no file appeared on the host. The same command under `sandbox-on` returned
EROFS. Two different behaviours for the same operation, and this spike does not
know why — a plausible reading is that the denied path was masked rather than
refused, but nothing here distinguishes that from other explanations. Recorded
rather than guessed.

## What this does **not** establish

- **Anything about `WebFetch` or MCP dispatch.** Only `Read` and `Write` were
  tested. The claim "the sandbox does not constrain in-process tools" rests on
  two of them.
- **That `allowUnsandboxedCommands: false` is enforced.** Untested here, as in
  spike 0008.
- **That `user`/`project`/`local` settings are honoured** for any sandbox key.
  Only that the cascade carries them.
- **Anything about macOS.** One platform, one CLI and SDK version.
- **A clean result for the `shim, gate on` arm.** It ended on `error_max_turns`
  after four attempts, so "contained" there is bounded by the turn cap.
- **Why a scoped deny makes Bash report success while writing nothing.**

## Harness defects found before spending, and after

Three were caught by reviewing the harness against spike 0008's defect table
**before** the first run: a non-vacuity gate that printed beside the other
criteria instead of suppressing them; witnesses that were not attributed to the
tool meant to produce them, so a `cat` through Bash would have satisfied the
`Read` witness; and `partb.sh` running the probe under `sudo -u`, which switches
uid but leaves `HOME` pointing at root's.

Three more the runs found:

| # | Defect | How it surfaced |
|---|---|---|
| 1 | `Read(**)` expanded into the sandbox's filesystem configuration, producing a 3.9 MB bwrap command line and `E2BIG` from `/bin/bash` | the arm's own Bash output; it was reported as "deny rules failed" until the message was read |
| 2 | `canUseTool` was never invoked — bare `allowedTools` entries auto-approve before it | the SDK warned, and the callback counted 0 across every arm |
| 3 | `partb.sh` exited silently under `set -o pipefail` when a login shell could not find a version-managed `node` — before the cleanup trap was installed | a run that printed nothing at all |

Defect 1 is the one worth keeping: a broad deny rule under `sandbox.enabled` can
make Bash unusable through an argument-limit failure that names nothing about
its cause. The profile generator should not emit unbounded path patterns.

Defect 3 was in a script that writes into `/etc`. The trap is now installed
before anything that can fail, and the cleanup message distinguishes removing
the file from never having written one.

## Versions

Claude Code **2.1.229** / Agent SDK **0.3.229**, Debian 13, `sonnet`, Node
24.19.0 — one release train ahead of the 0.3.226 that produced spikes 0008 and
0009. Total cost across all runs: **≈ $1.39**.

## Reproducing it

```bash
cd spikes/0010-non-bash-containment
pnpm install
pnpm run settings                            # Part 0 — no model calls
pnpm start                                   # Part A — 4 arms
ARMS=deny-catchall,deny-scoped pnpm start    # or a subset
sudo ./partb.sh                              # Part B — Linux, writes to /etc
```

`partb.sh` places a root-owned managed-settings file for the duration of the
run. While it exists, every Claude Code process on the machine resolves a
deliberately broken sandbox. Read its header first.
