# 0021. Containment is an allowlist, applied to every call

**Status:** Accepted
**Date:** 2026-09-02

## Context

[ADR-0007](0007-quarantine-untrusted-content.md) specifies a quarantine agent
with "**no tools** beyond what inspection requires", and `@cortana/policy`
implements that as a `QUARANTINE` profile whose comment reads "**no tools at
all**". [Spike 0011](../spikes/0011-quarantine-escape.md) measured a bare tool
name in the provider's deny list removing a tool from a session rather than
gating it, and the M3 plan recorded that as "the strongest available lock".

All of that was true and none of it was sufficient. Four measurements on
**2026-09-02**, taken while wiring the profile into the M3 agent, against Claude
Agent SDK 0.3.247:

1. **A session opened under `QUARANTINE` called `ToolSearch`, and it
   succeeded.** Asked to enumerate what it had, the same session listed
   **eighteen** tools by name — `Artifact`, `Skill`, `SendMessage`, `CronCreate`,
   `ToolSearch` and others — of which `KNOWN_TOOLS` named **none**. Withholding
   by name can only reach names this repository knows, and the provider's
   catalogue is larger than that and changes without asking. `ToolSearch` is the
   sharpest instance: a tool whose purpose is to make further tools reachable.

2. **`canUseTool` never fired for `Read`.** The project's open questions had
   already settled on it as the permission-escalation transport — "SDK
   `canUseTool` callback in-process, not a `--permission-prompt-tool` MCP
   server" — and it is the **ask** surface only: a call the provider resolves to
   `allow` on its own never reaches it. A session granted `Read` with
   `readable: ['…/allowed.txt']` read a file outside that list, and nothing was
   consulted.

3. **The provider documents the allowlist, in the option it points to from
   `allowedTools`**: "To restrict which tools are available, use the `tools`
   option instead", where `[]` disables every built-in tool. With
   `tools: profile.tools`, the same quarantine session answers `NONE`, and a
   structured session still returns its value — so the end-turn carrier
   ADR-0015 depends on is not withheld by it.

4. **A `PreToolUse` hook fires where `canUseTool` does not**, including for
   `Read`, and its `deny` holds: the file outside `readable` came back `CANNOT`.
   A hook `allow` short-circuits `canUseTool`, so the two are not redundant
   surfaces but a gate and a backstop.

Every unit test in the repository passed on the morning of that day. They
checked what the adapter **computed**; the leak was in what the session
**received**. That is the fifth occasion in this project where a check passed
for the wrong reason, and the second in one milestone.

## Decision

**A profile's `tools` field is an allowlist of what exists, and every tool call
is decided against the profile before it runs.**

Three mechanisms, and each is load-bearing for something the others cannot do:

| Mechanism | What only it can do |
|---|---|
| The provider's `tools` option | Decide what the session is **given**. The only one that reaches a tool this repository has never heard of |
| A `PreToolUse` hook | Decide **every call**, including the ones the provider would resolve on its own. The only place `readable`, `writable` and `denyRead` are enforced for in-process tools |
| `canUseTool` | The same decision on the surface a hook `allow` short-circuits. Covers whatever the hook did not see |

The rendered deny rules from spike 0011 stay as a fourth statement for the names
this adapter does know. They are not the boundary any more; they are the
boundary said again, which is the standing rule rather than redundancy.

**The decision function is one function** (`createGate`), called by both
surfaces, so the two cannot disagree. It fails closed four ways: an unnamed tool
is refused by the allowlist, a path outside the profile is refused, an `ask` with
nobody to ask is refused, and **a defect in the decision path is a refusal**
rather than an error the provider is free to read generously.

## Consequences

- **`QUARANTINE` means what ADR-0007 says for the first time.** The measurement
  that establishes it is promoted into the runner contract, so it is re-run
  against the real provider whenever the provider changes underneath this code
  — the treatment spike 0005's kill test got in M1.
- **`KNOWN_TOOLS` is demoted.** It was the containment surface; it is now a list
  of names this adapter can describe, and being incomplete is no longer a hole.
- A tool the adapter cannot describe is refused rather than passed through: it
  gets a request carrying its name and nothing else, and a profile is an
  allowlist, so no branch has to remember to refuse it.
- **A cost.** The gate runs in this process on every tool call, so a slow
  decision is a slow session. It is a pure function over a small profile plus,
  at most, one question to a person — and the question is the point.
- **The `ask` path is one route.** The tools a model uses inside its session and
  the actions it asks the kernel for reach the same `approve`. Two approval
  routes with different answers would be worse than one, because only one of
  them would be the one anybody tested.

## Alternatives considered

**Enumerate the provider's tools and keep withholding by name.** Rejected by
measurement 1: the list was eighteen long, none of it documented as an interface,
and `ToolSearch` implies it is not a fixed set. A containment surface that has to
be kept in sync with somebody else's catalogue fails on their release schedule.

**Rely on `canUseTool` alone**, as the resolved open question assumed. Rejected
by measurement 2: it does not fire for reads. The open question is not wrong
about the transport — an in-process callback rather than an MCP prompt tool — and
it is answered by the hook rather than by `canUseTool`.

**Rely on the OS sandbox.** [Spike 0010](../spikes/0010-non-bash-containment.md)
already settled this: it does not constrain in-process tools.

## Addendum, 2026-10-10: two ways round the gate that are not calls

Found while moving the adapter from Agent SDK 0.3.272 to 0.3.295. Neither
changes the decision; both are places where "every call" turned out not to be
every way in.

**A file named in the prompt is read without a call.** The provider expands an
`@/path` in a user message into an attached file **before the model is asked
anything**, and neither the hook nor `canUseTool` hears of it. Measured with
both surfaces recording: a session granted `Read`, sent `@/path` to a file
outside its `readable`, returned the file's contents with **zero** calls
reaching the gate — the model described it as a `Read` it had made. A session
with no tools, and one with `Read` denied by bare name, did not leak, so
`QUARANTINE` was never exposed. Every profile that grants `Read` was: its
`readable` scope is enforced by the gate, and the gate was not asked.

Every session is now opened with `verbatimPrompts: true`, under which the
provider delivers the text as written — no file mentions, no slash-command
dispatch. The kernel composes every prompt and some of what it composes was
written by somebody else, which is the case the option exists for.
[`mention.manual.ts`](../../packages/runner-claude/src/mention.manual.ts) is the
measurement, with a positive control; `orchestration.test.ts` checks the option
reaches the provider.

**An omitted permission mode stopped meaning `default`.** SDK 0.3.286 left it
to the provider, which starts a session in `auto` where that is its default —
telemetry off, or a third-party provider. In `auto` a classifier approves calls
and `canUseTool` hears only the ones it cannot decide, so the table's third row
would go quiet without anything failing. The adapter now states `default`, the
mode every measurement above was taken in.

## Revisit when

The provider gains a way to enumerate a session's actual tool set at runtime — an
adapter could then assert the allowlist held rather than trusting that it did —
or `canUseTool` starts firing for every call, at which point the hook and the
callback stop being two different things.
