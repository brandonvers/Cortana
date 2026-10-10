# First use — reachable from a phone

**Status:** Proposed
**Date:** 2026-10-10
**Version target:** none of its own — it ships inside `0.4.0`

---

## What this is, and why it interrupts M4

**The first time the system is used for real work.** M1 to M4's fourth step built
a kernel, a model port, an agent that talks and asks before it acts, a roster,
and reports that survive the process. Two months in, its one intended user has
not used it once: the only way to reach it is a socket on the machine it runs on,
from a terminal.

The argument for building the maintainer's own uses alongside the framework
applies to the framework itself: an extension point that has never had a
demanding consumer is an imaginary extension point. M4's next step is
delegation, and the questions it has to answer — what a delegate is handed,
when to give up on one, whether its
profile is intersected with its delegator's — are better answered by a week of
somebody asking it for things than by another plan.

So M4 **pauses after step 4** and this is built in between. It was offered on
2026-09-16 and declined in favour of finishing M4; it was taken on 2026-10-10.

### It is an exception to the rule, stated as one

[RELEASING §2](../RELEASING.md) says no milestone starts before the previous
one's definition of done is met, and the reason it gives — "a broad, shallow,
half-working surface" — is the right reason. This does not break it quietly:

- **Nothing here is half of a later milestone.** The chat channel is built as a
  second channel beside the socket, not as a module — the module host is M7, and
  building one for a single consumer is the guess the M1 plan warned against.
  The credential store is ADR-0018's, read side only, because there is now a
  first credential.
- **M4 resumes at step 5 when this is done**, and nothing in M5 starts before
  M4's definition of done is met.
- It is small enough to finish. Five steps, each one a pull request.

## Definition of done

- [ ] A message from the owner's phone reaches the agent and the reply comes
      back. A message from **any other account reaches nothing** — not the
      model, not the audit — and is counted rather than answered
- [ ] An approval the policy engine puts to a person reaches the phone as two
      buttons, and **silence, a stale button, or a press from anyone else is a
      no**, which is the guarantee the socket's approvals already give
- [ ] The bot's token is the **first credential [ADR-0018](../adr/0018-secrets-at-rest.md)
      stores**: from `systemd-creds` on Linux, from the Keychain on macOS, never
      from `config.toml`, and never in a log line
- [ ] It runs on the deployment target as the service, signed in to the
      provider **by the service's own user, through the provider's own login** —
      [ADR-0001](../adr/0001-model-access-behind-a-port.md) unchanged, no provider
      credential handled here. Measured on the machine, not described
- [ ] `cortana` is a command: the terminal client, installed, rather than a
      manual script
- [ ] **A week of real use is written down**: what was asked, what worked, what
      failed, and what was missing. M4's step 5 reads it before it is planned in
      detail

## The packages

| Package | Owns | Depends on |
|---|---|---|
| `@cortana/telegram` | The bot: long polling, the allowlist, turning a message into a turn and an approval into buttons | `core`, `config`, `policy` |

The kernel wires it beside the socket, from the same `onSay` shape — so a turn
reaches the agent the same way whichever channel it came in on, and the agent
never learns which.

## The order of work

**1. The Telegram channel.** [grammY](https://grammy.dev) over long polling,
already chosen in the technology stack because it needs no public endpoint and
no TLS. Text in, text out, a reply split at Telegram's 4,096-character limit, and
a typing indicator while a turn runs.

> The allowlist is **numeric user ids**, which Telegram asserts, rather than
> usernames, which their owners change. An update from anyone else is dropped
> before it is parsed for anything but its sender, so a stranger's text never
> becomes a turn.
>
> **A forwarded message is not the owner's words.** It carries somebody else's
> text, and [ADR-0007](../adr/0007-quarantine-untrusted-content.md) says what
> happens to that: it is inspected before it is trusted. Until a forwarded
> message can go through the quarantine, it is **refused with a sentence saying
> why**, rather than handed to the main agent as though the owner had typed it.

**2. The first stored credential.** ADR-0018's store, read side only. On Linux
the unit loads it with `LoadCredentialEncrypted=` and the daemon reads it from
`$CREDENTIALS_DIRECTORY`, so it is decrypted by systemd before the process starts
and the process never holds a key. On macOS it comes from the Keychain through
the `security` command already on the system. The configuration names the
credential; it never holds its value.

> **What the step found.** Two failures that would only have shown on the
> server. grammY's start retries an unreachable Telegram **forever** — measured
> backing off from 100 ms to several seconds — so a network that was down at
> boot was a daemon that never finished starting; the start now has a deadline,
> and an unreachable Telegram leaves the socket serving while the bot tries
> again. And a component that failed for a configuration reason exited as a
> start failure, which the unit restarts: a missing token would have restarted
> the daemon every five seconds, forever. It now exits as configuration, which
> the unit leaves for the operator.
>
> The reader refuses rather than descends. On a machine whose credentials are
> held by `systemd-creds`, a daemon started by hand is told to run as the
> service; it is not handed a plaintext file because one happened to be there.
> The unit line that gives the service its credential, `ImportCredential=`, is
> named in the refusal and **not yet measured** — that is this step's work.

**3. On the deployment target, for real.** The service's own user signs in to
the provider once, with the provider's own login, and its credentials live in
that user's home — which the unit already makes its state directory, the one
place `ProtectSystem=strict` leaves writable. The install notes in
`cortana.service` gain the two lines this needs, and are re-run on the machine.

**4. `cortana`.** The client `talk.manual.ts` already is, as a command.

**5. A week of use.** The owner's persona and anything domain-specific live in
the owner's own configuration, not in this repository — the core knows no
domain. What the week finds is recorded, and is what step 5 of M4 starts from.

## What it does not build

| Not here | Where |
|---|---|
| **Photos.** The use that motivated this needs them — a picture of a finished job is most of a post — and the runner port is text-only. Changing a port deserves its own review | The first thing after this |
| Forwarded messages, inspected | When the quarantine is reachable from a channel |
| Memory — the agent forgets when the daemon restarts | M5 |
| Publishing anywhere. It drafts; the owner posts | A connector, once each platform's approval process is known |
| A team. One agent answers | M4, from step 5 |
| Anything that speaks first | M6 |

## Risks

- **Telegram is not end-to-end encrypted.** Bot messages transit Telegram's
  servers. This was accepted when the channel was chosen, and is repeated here
  because it is now true rather than planned.
- **The token is the bot.** Whoever holds it can read what the bot is sent and
  answer as it. It cannot make them the owner — the allowlist is checked on
  every update — which is why the allowlist is the control and the token is
  protected anyway.
- **A silent bot looks like a slow one.** The daemon is on one machine; when it
  is down, a message waits in Telegram and nothing says so. The first version
  accepts that. A health line the bot can answer without waking a model is
  cheap, and is added if the week of use asks for it.
- **The provider's terms.** A person's own agent, on their own machine, signed in
  with their own account, is the shape the provider's terms describe as ordinary
  individual use; re-verified on 2026-10-10. ADR-0001's revisit condition still
  stands.
