# Concepts

How Cortana is put together and why. Read this before the
[decision records](adr/) — they assume the vocabulary defined here.

> This document describes the design. **It is not a description of working
> software.** See the status note in the README.

---

## 1. The shape of the system

One person talks to one agent. That agent runs a team.

```
      you
       │  chat channel
       ▼
┌─────────────────────────────────────────────────────────┐
│  KERNEL                                                 │
│  durable queue · scheduler · policy · audit · budget    │
│  agent inboxes · module host · presence                 │
└───┬─────────────────────────────────────────────────────┘
    │
    ▼
┌───────────────┐   delegates    ┌──────────────────────────┐
│  main agent   │───────────────▶│  resident specialists    │
│  one, always  │◀───────────────│  own session each        │
└───────────────┘   reports      └────────┬─────────────────┘
                                          │ spawns
                                          ▼
                                 ┌──────────────────────────┐
                                 │  ephemeral workers       │
                                 │  subagents, die on done  │
                                 └──────────────────────────┘
```

Nothing in that picture knows what your work is. Domain capability arrives as
**modules**, described in §5.

## 2. The main agent

There is exactly one, and it lives as long as the instance does. It is the only
agent you talk to.

It does two jobs:

- **It manages.** Decomposes a request, decides who should do what, tracks
  progress, checks the result, answers you.
- **It decides.** The significant calls belong to it, not to whoever happens to
  be holding the task.

It is also the only component with a view of everything: every job, every team,
every result, and the history of what you asked for and how it went. The
specialists know their domain. The main agent knows you.

That asymmetry is the point. A specialist asked to "write the post" has no way
to know that you rejected a similar phrasing last week. The main agent does, and
it is the one that decides what reaches you.

## 3. Agents

### 3.1 Two classes

**Resident agents** are part of the roster. Each has a stable identity: its own
system prompt, its own memory, its own tools, its own history. You author them,
and modules contribute them.

**Ephemeral agents** are created for one task when nothing on the roster fits.
When the work ends, the main agent decides whether to **promote** the agent to
resident or **discard** it, based on how likely the situation is to recur — a
one-off question is discarded, a recurring kind of work becomes a colleague.

Both are described by the same definition, so promotion is a state change rather
than a rewrite.

### 3.2 An agent definition

| Field | Meaning |
|---|---|
| `prompt` | The system prompt. The agent's competence and character. |
| `tools` / `disallowedTools` | What it may reach for. Never the security boundary — see §7. |
| `model` | Which model tier it runs on. Assigned, not fixed — see §3.4. |
| `effort` | How hard it thinks. Also assigned. |
| `memory` | Which memory scope it reads and writes. |
| `skills`, `mcpServers` | Capability packaged by a module. |
| `maxTurns` | Blast radius. |

### 3.3 Dormancy is the default

An agent that is always awake is always costing tokens and context. So residency
is an **identity, not a running process**.

| State | Meaning |
|---|---|
| `dormant` | Definition and memory exist. No session. Costs nothing. **Default.** |
| `warming` | Session starting, context loading. |
| `active` | Working. |
| `idle` | Session alive, nothing to do. Returns to `dormant` after a TTL. |

An agent wakes on delegation, on a schedule, on being addressed directly, on a
subscribed event, or on a prediction from the presence engine (§6).

This is what makes a roster of a dozen specialists affordable: at any moment two
or three of them are awake.

### 3.4 Model and effort are assigned

The main agent chooses which model tier and effort level each agent runs at, and
may change them when circumstances justify it — promoting a struggling agent,
demoting a routine one to save budget.

One constraint shapes how: **changing model or effort invalidates the prompt
cache**, forcing an expensive uncached turn. So the choice is made at wake time
by default, where it costs nothing. A mid-session change is allowed but requires
a stated reason, and is logged with the cache cost it caused. The budget
governor can veto an upgrade when headroom is short.

### 3.5 Nesting

A resident may spawn subagents, and those may spawn their own, to a configurable
depth. Because residents are separate *sessions* rather than subagents, the depth
counter resets at each session boundary, so the topology has more headroom than
the raw limit suggests.

## 4. How work gets done

### 4.1 Two collaboration modes

The main agent picks per job, records the choice, and the choice is auditable.

**Pipeline** is the default: agents run in sequence, each consuming the previous
one's output. Cheap, deterministic, and correct for most work.

**Debate** is an escalation: when the grounding data is thin and the risk of
confident invention is high, several agents argue the question, try to refute
each other, and converge. Slower and materially more expensive — and materially
more reliable, because a claim that survives three agents trying to break it is
not the same object as a claim one agent produced unopposed.

Choosing debate requires a stated reason, which is logged. That keeps it from
becoming a reflex.

### 4.2 Direct messaging

Teams and individual agents may talk to each other directly when that is the
shorter path. Not everything routes through the main agent. What does route
through it is anything that reaches you, and any decision that carries weight.

### 4.3 One request, one answer

The main agent is a single session, so it reads one thing at a time. If three
teams finish in the same second, a naive design either blocks you behind them or
drops a report. So **the kernel receives reports, not the main agent.**

Every report is written to durable storage the moment it arrives, before anything
acknowledges it. From there the kernel decides when to deliver:

1. **A blocker or a decision request is delivered immediately.** A team that is
   stuck does not wait for its siblings.
2. **Otherwise the report is held until the request is complete**, then the whole
   set is delivered in one turn. The main agent synthesises one answer from the
   full picture rather than narrating fragments as they trickle in.
3. **A per-request timeout bounds the hold**, so one stalled team cannot withhold
   what its siblings already finished. On timeout the main agent gets what is
   ready and is told what is missing and why.

Two consequences, both intended: **you are never queued behind the machinery** —
you can interrupt, ask, or redirect at any time — and progress is **observable
without being interruptive**, because reports are durable and visible whether or
not the main agent has read them yet.

### 4.4 Verification

The main agent reviews output before it reaches you. A result that fails review
goes back with feedback rather than forward.

## 5. Modules

**A module is a team you hire.** It contributes agents plus the tools those
agents need. Installing the mail module does not add "a mail feature" — it adds
someone who handles mail, and gives them the mailbox.

A module may register:

- **Agents** — a definition each
- **Tools** exposed to agents over MCP
- **Scheduled jobs**
- **Chat commands** and event subscriptions
- **A configuration schema**, validated at boot
- **A health check**

It gets a namespaced configuration section, a namespaced storage area, and a
supervised failure boundary. It cannot reach into another module's state.

### 5.1 Two kinds

| | **Connectors** | **Packs** |
|---|---|---|
| What | Generic, reusable capability | An opinionated workflow |
| Knows about | A protocol | Your life |
| Examples | IMAP/SMTP, CalDAV, media assembly, a chat channel | "triage the morning's enquiries", "brief me on my day" |
| Ships | In this repository, optional, off by default | You write it |

**Packs do not have to be public.** A pack encodes how *you* work, and can live
in a private repository that this system loads from a path. The framework and the
connectors are the open-source product; what you do with them is yours. That is
the intended shape for every user, not a workaround.

### 5.2 Off means off

A disabled module loads no code, opens no connection, and runs no job. This is a
correctness property, not an optimisation: a user who does not want a capability
should not be running it, debugging it, or trusting it.

### 5.3 Failure is contained

Modules run inside a supervised boundary with timeouts and a circuit breaker, and
a module may declare that it needs its own process when in-process containment is
not enough.

But the honest version of "a failing part must not stop the system" is not that
nothing ever crashes — a native crash or an out-of-memory kill takes the process
regardless. It is that **crashing is cheap**: every piece of state is durable
before it is acknowledged, so a restart loses no work. Resilience here is
measured in what survives a `SIGKILL`, not in uptime.

## 6. The presence engine

A core component that learns, per user: when you are awake and reachable, which
agents get used at which times, and which hours are historically bad for
interrupting you.

It uses this for two things — **pre-warming** the agents likely to be needed
soon, and **gating** proactive messages.

It starts with a learning period and conservative defaults. Every inference it
makes is visible and overridable: if you would rather state the rules outright
than let it guess, you can, and explicit configuration always wins.

**Proactive speech is earned.** The default is silence, and the threshold is
yours.

## 7. Trust and security

The threat model is concrete. The system reads mailboxes and fetches web pages,
which means **attacker-controlled text reaches a model that can send mail and run
commands**. Prompt injection is not a hypothetical here; it is the expected case.

### 7.1 Trust levels

Every piece of content entering the system carries one.

| Level | Source | Ceiling |
|---|---|---|
| `owner` | You, through a verified channel | Full. May authorise escalations. |
| `system` | The kernel — scheduler, internal jobs | Full within its job profile. |
| `untrusted` | Fetched pages, mail bodies, third-party data, forwarded messages | **Data only.** May never originate an escalation, a write outside the sandbox, or a durable memory write. |

### 7.2 The quarantine agent

Untrusted content does not enter the system directly. It goes first to a
**quarantine agent**: created for that one piece of content, destroyed when it
returns its verdict.

The quarantine agent has **no memory access**, **no tools** beyond what
inspection requires, **no network**, and **no ability to delegate**. Its only
output is a structured verdict — safe, suspicious, or hostile — with the content
in a neutralised form.

Only what clears quarantine reaches the agents that hold data and tools.

What makes this strong is not what it does but what it denies. While the intent
of a piece of content is still unknown, there is nothing in that agent's reach
worth attacking. An injection payload lands in a sandbox with no memory, no
credentials, and no way out.

### 7.3 Defence behind it

- **One-way downgrade.** If untrusted content reaches a working session anyway,
  that session drops irreversibly to a restricted profile for the rest of its
  life.
- **Two layers, always.** Every security property is enforced by the policy
  engine *and* by an OS-level sandbox. Tool allowlists in frontmatter are
  ergonomics, never a boundary.
- **Generated profiles set `sandbox.allowUnsandboxedCommands: false`**, alongside
  `failIfUnavailable: true`.

  At the documented default (`true`), a model-supplied `dangerouslyDisableSandbox:
  true` takes a Bash command out of the sandbox — which makes the OS layer
  *model-discretionary* and leaves the policy engine as sole adjudicator on
  exactly the commands the sandbox had refused.
  [Spike 0008](spikes/0008-sandbox-integration.md) observed a model emitting that
  parameter without being asked to, with the write landing when the permission
  callback allowed the call.

  **Adopted on the setting's documented semantics, not on a measurement.** Spike
  0008 did not verify it is enforced, and exercised it on no path other than the
  SDK `sandbox` option. Both settings must be asserted at runtime against pinned
  CLI and SDK versions rather than assumed — and see that report for why "two
  layers" does not currently hold for tools other than Bash.
- **Secrets never enter model context.** Encrypted at rest, scrubbed from
  subprocess environments.
- **Real-world actions need approval.** Sending mail, publishing, spending —
  explicit approval by default, with timeout meaning deny.

## 8. Memory

Four tiers, addressed by the agents as a tool rather than stuffed into every
prompt — which keeps the prompt prefix stable and lets an agent ask for more when
it needs more.

| Tier | Contents | How it is reached |
|---|---|---|
| Hot | Identity, standing preferences, open threads | Always in context, hard token cap |
| Warm | Recent and salient episodic memory | Retrieved per turn |
| Cold | Archive | Explicit search only |
| Shared | Cross-agent facts, canonical entities | Read by all, written through a validated path |

Retrieval fuses a lexical index and a vector index by reciprocal rank fusion,
weighted by salience — recency decay, access count, and the trust level of the
source.

> ⚠️ **This rule is open, not settled.** Two spikes have now measured *unweighted*
> fusion and found it harmful: [0006](spikes/0006-multilingual-retrieval.md) cost
> the best model 16.2 points of recall@1 and 0.109 MRR on semantic queries, and
> [0007](spikes/0007-lexical-routing.md) found no lexical weight between 0.1 and
> 0.9 that beat vector search alone. Neither measured the salience weighting this
> paragraph actually specifies, and 0007 failed its own pre-registered criterion
> and answers nothing.
>
> So: fusing on every query is a plausible default with evidence against one form
> of it and no evidence for the specified form. **No replacement is proposed** —
> the measurement that would justify one is a benchmark rather than a spike, and
> what it needs is listed at the end of the 0007 report.

### 8.1 Language is a design constraint, not a detail

SQLite's full-text search ships stemmers for a handful of languages. For a
language it does not stem — and for agglutinative languages in particular — a
lexical index **silently** fails to match inflected forms. The query succeeds and
returns nothing, and the empty result then poisons the fusion.

This was measured rather than assumed; see the [spike report](spikes/). The
design that follows from it: **two lexical indexes, not one** — a diacritic-
folding index so accented text matches unaccented queries, and a parallel trigram
index so inflected forms still match their stem. The vector index carries the
semantic load, which is why the embedding model must be genuinely multilingual
rather than English-first.

## 9. Model access

Agents run on **your own** AI provider subscription, through the provider's own
locally installed tooling, which you authenticate yourself.

Cortana never handles your provider credentials, never offers a "log in with
your provider" flow, and never proxies anyone's requests. It is a harness you run
on your machine against your own account.

Everything that touches the provider lives behind a single port, and exactly one
package may import that provider's types. Provider policy on programmatic use has
moved more than once, and a boundary is cheaper to maintain than a migration.

## 10. What the kernel owns

Everything that must survive a restart.

| | |
|---|---|
| Durable queue | Jobs with leases, attempts, backoff, idempotency keys |
| Scheduler | Timezone- and DST-correct, with catch-up after downtime |
| Agent inboxes | Reports, held and aggregated per §4.3 |
| Policy engine | Trust levels, profiles, permission rules, approvals |
| Budget governor | Classifies work by urgency; degrades before it drops |
| Audit store | Every prompt, tool call, decision, and cost, correlated |
| Module host | Configuration, lifecycle, health, failure boundaries |
| Presence | The rhythm model behind waking and speaking |

The rule that keeps this honest: **no state exists only inside a model session.**
A session can be killed at any moment with zero data loss. If that is not true of
something, it belongs in the kernel.
