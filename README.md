# Cortana

**A self-hosted framework for running a team of AI agents on your own machine.**

> **Status: pre-alpha. There is no working software yet.**
> The repository currently holds the design, the decision record, and the project skeleton.
> Implementation begins after the verification spikes in `docs/spikes/` are complete.
> Nothing here is stable, and everything may change.
>
> ---
>
> **⚠️ Not affiliated with Microsoft.**
> This project has **no connection whatsoever** to Microsoft Corporation, to
> Microsoft's discontinued Cortana assistant, or to the Halo video game series.
> "Cortana" is a registered trademark of Microsoft Corporation. This is an
> independent, non-commercial, open-source project by an unrelated individual,
> and the name implies no endorsement, sponsorship, or association of any kind.
>
> It is likewise **not affiliated with Anthropic PBC**. It is a third-party
> harness you run on your own machine, against your own account. See
> [NOTICE](NOTICE) for the full statement.

---

## What it is

You talk to one agent. It runs the rest.

Cortana is a runtime for a standing team of AI agents on hardware you own. You have a
conversation with a single main agent through a chat channel. It breaks your request down,
hands the pieces to the specialists whose competence fits, lets them work — in sequence when
the job is sequential, or as a structured debate when the topic is one an AI is likely to
confabulate about — checks what comes back, and answers you once, with the whole picture.

Everything domain-specific is a module you install, enable, or write. The framework itself
knows nothing about your work, your business, or your life. It knows about agents, delegation,
memory, scheduling, trust, and cost.

## What it is not

- **Not a hosted service.** There is no server of ours, no account with us, no subscription to
  us. You run it, on your machine, with your credentials.
- **Not multi-tenant.** One instance serves one person. That is a design decision, not a
  missing feature.
- **Not a chatbot wrapper.** The point is the coordination: several agents doing different
  parts of one job and one answer coming back.

## How it works

| Piece | What it does |
|---|---|
| **The main agent** | One per instance, for the life of the instance. The only agent you talk to. Manages the work and makes the significant decisions. The specialists know their domain; it knows you. |
| **Resident agents** | Persistent specialists with their own identity, memory, and tools. Dormant by default and woken when needed, so a large roster stays affordable. |
| **Ephemeral agents** | Created for one task when nothing on the roster fits, then either promoted to resident or discarded. |
| **Modules** | A module is a team you hire. It contributes agents plus the tools they need. Installing the mail module does not add "a mail feature" — it adds someone who handles mail, and gives them the mailbox. |
| **The kernel** | Owns everything that must survive a restart: the durable queue, the scheduler, the policy engine, the audit trail, the budget governor, and the agents' inboxes. |

Read [docs/CONCEPTS.md](docs/CONCEPTS.md) for the full model, and [docs/adr/](docs/adr/) for why
each significant decision went the way it did.

## Design commitments

These are invariants. A design that violates one is wrong, not merely different.

1. **The core knows no domain.** Anything domain-specific is a module, or it is a bug.
2. **A failing part must not take the system with it.** State is durable before it is
   acknowledged, so even a total crash is a restart with no lost work. Resilience here means
   "crash is cheap", not "never crashes".
3. **Off means off.** A disabled module loads no code, opens no connection, and runs no job.
4. **Untrusted content is inspected before it is trusted.** Incoming mail and fetched web pages
   are attacker-controlled text reaching a model that can run commands. They go to a quarantine
   agent with no memory, no tools, and no way out, and only its verdict travels onward.
5. **Every security property is enforced twice** — by the policy engine's allow decision and
   by a second mechanism that depends on the tool: an OS-level sandbox for spawned commands,
   a path-scoped deny rule for in-process ones. Never by prompt text or frontmatter.
6. **Proactive speech is earned.** The default is silence, and the threshold is yours to set.
7. **API-first.** The web dashboard is the first client, not a special case.

## Requirements

| | |
|---|---|
| OS | Linux x86_64 (Debian is the reference) or macOS on Apple silicon. Windows is not supported. |
| Runtime | Node.js ≥ 24.12 |
| Hardware | A machine that stays on. This is a daemon, not an app you launch. |
| AI provider | Your own Claude subscription, authenticated in your own Claude Code installation. Cortana never handles your credentials. |

## Project layout

```text
packages/     the framework — kernel, runtime, memory, policy, audit, modules
docs/         concepts, architecture decision records, spike reports, milestone plans
spikes/       throwaway verification scripts; never merged into packages/
```

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) — it covers the
development setup, the DCO sign-off requirement, and how decisions get made and recorded.

Because this project executes shell commands and holds credentials, please read
[SECURITY.md](SECURITY.md) before reporting anything security-related. Do not open a public
issue for a vulnerability.

## Licence

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Cortana is an independent open-source project with no affiliation to Microsoft Corporation or
to Anthropic PBC. See [NOTICE](NOTICE) for the full trademark statement.
