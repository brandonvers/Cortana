# First use — reachable from a phone

**Status:** In progress — steps 1 to 3 done; the server also follows `main` on its own
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

- [x] A message from the owner's phone reaches the agent and the reply comes
      back. A message from **any other account reaches nothing** — not the
      model, not the audit — and is counted rather than answered
- [ ] An approval the policy engine puts to a person reaches the phone as two
      buttons, and **silence, a stale button, or a press from anyone else is a
      no**, which is the guarantee the socket's approvals already give
- [x] The bot's token is the **first credential [ADR-0018](../adr/0018-secrets-at-rest.md)
      stores**: from `systemd-creds` on Linux, from the Keychain on macOS, never
      from `config.toml`, and never in a log line
- [x] It runs on the deployment target as the service, signed in to the
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

> **What the step found.** It works as planned, and the plan's one unmeasured
> line held: `ImportCredential=` on systemd 257 hands the service the token
> that `systemd-creds encrypt --with-key=auto` sealed with the host key — this
> machine has no TPM, so rung 2, as ADR-0018 predicted. The service user signed
> in with `claude auth login` under its own home, and the daemon came up with
> the bot polling and no restarts. The suite passes on the target itself, 672
> tests.
>
> The unit now imports the credential by default, which needed a second
> measurement because the manual does not say what a missing one does: a
> throwaway unit importing a name that does not exist finished `0/SUCCESS`, so
> a machine without the bot starts as before.
>
> Three things the plan did not say. The build already deployed was from
> 2026-09-05, so "deploy" meant updating a checkout, not making one. **One token
> is one poller**: Telegram refuses a second process polling the same bot, so a
> development copy has to stop before the server takes over. And the allowlist
> was demonstrated before it was configured: the owner's own first message
> arrived from an id not yet on it, was dropped unanswered, and was counted —
> which is also how the id was learned, without a third-party bot.
>
> **Approvals on a phone are not yet exercised live.** The agent has no tools,
> so nothing asks; the guarantee stands on the tests from step 1 until a tool is
> granted.

**4. `cortana`.** The client `talk.manual.ts` already is, as a command.

> **What the step found.** Two things the manual script got right for a script
> and wrong for a command. It refused every approval unless started with
> `--approve`; at a terminal there is a person, so now the question is put to
> them, and refused only when nobody is at the keyboard. And on the server it
> could not have worked as anyone: the socket belongs to the service user, and
> run as that user by hand it looked for the socket in the wrong place, because
> systemd tells the service where its data lives and nothing tells a shell. So
> the server gets a three-line wrapper that says it, and every refusal names the
> wrapper rather than leaving a person to work out `sudo -u` on their own.

**5. A week of use.** The owner's persona and anything domain-specific live in
the owner's own configuration, not in this repository — the core knows no
domain. What the week finds is recorded, and is what step 5 of M4 starts from.

## Added on the way

**The server follows `main`** (#75), asked for once the bot was answering: a
timer fetches every five minutes, and a new commit is installed, tested on the
machine, deployed, and confirmed — or rolled back. It is in this plan rather
than M7's packaging because first use is where it was needed: a fix that lands
and then waits for someone to log in to the server is a fix the owner does not
have.

**Its first run found a bug the developer machine and CI could not** (#74): the
suite read the machine's own `/etc/cortana/config.toml`, which on the server
exists and belongs to the service, and fourteen tests failed there only. The
deploy refused it — which is the reason it runs the suite on the target at all.

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
