# M3 — the conversation

**Status:** Proposed
**Date:** 2026-09-02
**Version target:** `0.3.0`

---

## What M3 is

**The first version you can use.** M1 built a process that holds state; M2 built
the thing that talks to a model and records what it did. Neither of them can be
addressed. This one can: you say something and it answers.

One agent, not a team. The roster is [M4](../RELEASING.md), which was added to
the plan while writing this one — the agents, delegation and report aggregation
that [CONCEPTS §3](../CONCEPTS.md) and §4 describe were in no milestone at all,
which is close to saying the product was not in the plan.

What that leaves M3 is still the most security-relevant milestone so far, because
it is the first where **content this system did not write reaches a model that
can act.** Five spikes exist for it and none of their findings is optional.

## Definition of done

- [ ] You can hold a conversation with it over a local socket, from the machine
      it runs on, and it remembers the conversation within a session
- [ ] **Every crossing from the model back into the kernel carries a schema**
      ([ADR-0015](../adr/0015-structured-output-at-the-model-boundary.md)), and
      what you read is a field of it rather than prose that was parsed
- [ ] A tool call the agent wants to make is **decided by the policy engine
      before it runs**, and a decision the policy engine will not make on its own
      is put to you
- [ ] **Untrusted content is inspected by a disposable agent before it is
      trusted** ([ADR-0007](../adr/0007-quarantine-untrusted-content.md)), and
      the profile that agent runs under is generated rather than written by hand
- [ ] The quarantine profile carries **every setting spikes 0010 to 0012 found
      necessary**, and a generated profile missing one fails a test rather than a
      review
- [ ] **The path form in a deny rule is verified, not assumed.** Spike 0011
      measured `Read(//abs/**)` holding and `Read(/abs/**)` leaking four times
      out of four
- [ ] A conversation survives the daemon restarting: what was said is in the
      audit, and the socket comes back
- [ ] An approval you never answer does not wedge the daemon

## The packages

| Package | Owns | Depends on |
|---|---|---|
| `@cortana/policy` | Trust levels, permission rules, the decision a tool call gets, and the profile generator | `core`, `config` |
| `@cortana/agent` | The one agent: its schema, its session, and the loop that runs a turn | `core`, `runner`, `policy`, `audit`, `bus` |
| `@cortana/channel` | The local socket, its framing, and the client the ops CLI will grow out of | `core`, `config`, `bus` |

`@cortana/policy` is separate from the agent because
[ADR-0007](../adr/0007-quarantine-untrusted-content.md) puts the same rules in
front of a quarantine agent, a resident in M4, and a module in M7. A policy that
lived inside the agent would be re-implemented three times, and the third one
would be the one with the mistake.

## The order of work

**1. `policy`, with the profile generator and its tests, before anything can
call a tool.** The spikes below already say what a correct profile contains; this
step turns that from prose into something a test fails on.

**2. `channel`.** A socket, a frame, a client. Small, and it makes everything
after it demonstrable rather than described.

**3. `agent`** — the schema, the session, the loop. This is where the decision
below about prose and structure becomes code.

**4. Approvals.** The path from "the agent wants to run this" to "you said yes",
including what happens when you say nothing.

**5. Quarantine.** ADR-0007's disposable agent, running under a generated
profile, with the escape test from spike 0011 promoted into the repository the
way spike 0005's kill test was in M1.

## What the spikes already settle

Five of them are M3's, and this is the milestone where they stop being reports.

| Finding | From | What it means here |
|---|---|---|
| The OS sandbox does not constrain in-process tools | [0010](../spikes/0010-non-bash-containment.md) | For `Read`, `Write` and friends the second layer is a **path-scoped deny rule**, not the sandbox. A profile that relies on the sandbox for them has one layer |
| `Read(//abs/**)` holds; `Read(/abs/**)` leaks | [0011](../spikes/0011-quarantine-escape.md) | **Four leaks out of four** on the wrong form. One character. The generator emits the rooted form and a test asserts the shape |
| A bare tool name in `deny` removes the tool | [0011](../spikes/0011-quarantine-escape.md) | The strongest available lock, and the one to use where a tool has no business existing at all |
| Bash is a read channel, and the default leaves it open | [0012](../spikes/0012-bash-read-channel.md) | Three settings close it, **none on by default**. All three belong in every generated profile |
| `strictMcpConfig` with an empty server map | [0011](../spikes/0011-quarantine-escape.md) | Otherwise a session inherits the operator's MCP servers — a tool surface nobody chose |
| Sandbox availability can be required rather than hoped for | [0010](../spikes/0010-non-bash-containment.md) | `failIfUnavailable` was measured for the first time there. A profile that silently runs unsandboxed is the failure this prevents |
| A framing that says "authorised test" made the model *less* compliant | [0011](../spikes/0011-quarantine-escape.md) | Attempts fell from 2/3 to 0/3. Prompt text is not a security control, in either direction |

## The decisions M3 could not avoid

Taken on **2026-09-02**, before any of it was written.

### 1. One structured session, and the reply is a field

The port fixes a session's output shape for its life — a finding from M2, forced
by the provider. The main agent has to do two things that look like they need
both shapes: answer you in prose, and hand the kernel a decision.

It does not need both. **The agent always returns a value, and what you read is
a field of it**: `{ reply, actions }`. That is exactly what
[ADR-0015](../adr/0015-structured-output-at-the-model-boundary.md) already
describes — "free text remains what it should be, the content of a message to the
user, never the carrier of a decision" — and it costs nothing. The alternative
was two sessions per agent at 263 MB each, where the deciding one would not have
heard the conversation it was deciding about.

### 2. A local socket, and a client in this repository

[CONCEPTS §5.1](../CONCEPTS.md) makes a chat channel a connector, and connectors
are modules, and modules are M7. Something has to carry a conversation before
then.

**A unix socket in the data directory, and a small client.** No dependency, no
listening port, no authentication to get wrong — the socket's permissions are the
authentication, and they are the same ones already protecting the database. Over
SSH it is as reachable as the machine is.

It is deliberately **not** a connector, and that matters for M7: the module story
stays intact because this is the kernel's own front door rather than the first
example of a thing modules provide. What it does become is the transport the ops
CLI needs anyway.

### 3. The policy engine decides; frontmatter never does

Not a new decision — [CONCEPTS §7.3](../CONCEPTS.md) says "tool allowlists in
frontmatter remain ergonomics, never a boundary" — but M3 is the first milestone
that can violate it, so it is restated where the code will be.

Every tool call is decided by `@cortana/policy`. An agent definition may express
a preference and the policy engine may consult it; nothing an agent says about
itself is permitted to be the only thing standing between it and a file.

## What M3 does not build

| Not in M3 | Where |
|---|---|
| More than one agent, delegation, report aggregation | M4 — added to the plan while writing this |
| Memory of any kind. A conversation ends and is gone, except in the audit | M5 |
| The scheduler, and anything that speaks first | M6 |
| A dashboard, a remote channel, packaging | M7 |
| The module host | M7 |

**No memory is the sharpest limit and worth stating plainly**: M3 answers you and
forgets. That is not a defect of the milestone, it is the shape of it — but it
means the thing you can finally use will not know yesterday, and the milestone
that fixes that is [blocked on a corpus](../spikes/README.md#outstanding) only
you can produce.

## Risks

- **This is the first milestone that can be wrong in a way that matters.** Every
  earlier one could lose data or waste money; this one can let content nobody
  wrote reach a tool that acts. The spikes are unusually specific about how, and
  the profile generator is where all of it lands.
- **A generated profile is only as good as its test.** Five of the seven findings
  above are settings whose absence is silent. A profile missing one behaves
  normally until the day it does not, which is why the definition of done asks
  for a test that fails rather than a review that notices.
- **Approvals are a place to deadlock.** A daemon waiting on an answer that never
  comes is a daemon that has stopped, and the timeout for it is the interesting
  part rather than an afterthought.
- **The socket is a security boundary chosen for its simplicity.** File
  permissions are a real control and a modest one. Anything that widens the
  channel — a port, a remote client — is a different decision and should be made
  as one.
