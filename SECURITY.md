# Security Policy

This project executes shell commands, holds credentials for third-party accounts, and passes
attacker-controllable text (email bodies, fetched web pages) to a model that can act. Security
reports are taken seriously.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private vulnerability reporting: go to the **Security** tab of this repository and
choose **Report a vulnerability**. That channel is private to the maintainers.

Please include:

- what the issue is, and which component it affects
- the steps to reproduce it, or a proof of concept
- what an attacker gains — data read, command executed, credential exposed, message sent
- the version or commit you tested
- anything you already know about mitigations

You will get an acknowledgement within **72 hours**. This is a single-maintainer project, so a
fix may take longer than that; you will be told where it stands rather than left waiting.

If you would like credit in the release notes, say so and give the name you want used.
Reporters who prefer to stay anonymous will be kept anonymous.

## Scope

Reports about the following are in scope and valuable:

- **Prompt injection that escapes containment** — content that reaches an agent with tools or
  memory without passing the quarantine stage, or that survives the one-way trust downgrade
- **Sandbox escape** — a command reaching the filesystem or network beyond its declared policy
- **Credential exposure** — secrets reaching model context, logs, the audit trail, transcripts,
  a subprocess environment, or the dashboard
- **Permission bypass** — an action taken that the policy engine should have blocked, or an
  approval satisfied by anything other than the owner
- **Privilege escalation between agents** — one agent obtaining capability it was not granted,
  including by asking another agent to act for it
- **Anything reachable from the network** — the local API or dashboard accepting a request it
  should have refused

## Out of scope

- Attacks requiring the owner's own credentials or physical access to the machine
- Vulnerabilities in Claude Code, the Claude Agent SDK, or Anthropic's services — report those
  to Anthropic
- Vulnerabilities in third-party dependencies with no exploitable path in this project; report
  upstream and open a normal issue here to bump the version
- Deliberate design decisions documented in `docs/adr/`. If you disagree with one, open a
  discussion rather than a vulnerability report — though a report is right if you can show the
  decision has a consequence its record does not acknowledge.
- Running the software in a configuration its documentation warns against

## Supported versions

Pre-1.0, only the latest commit on `main` is supported. There are no backports.

## Design notes for reviewers

Two properties are worth knowing before you look for holes:

1. **Security is enforced twice** — by the policy engine and by an OS-level sandbox (bubblewrap
   on Linux, Seatbelt on macOS). A defect in one layer is a valid finding even if the other
   layer holds.
2. **Skill and agent frontmatter is never a security boundary.** Tool allowlists declared in
   frontmatter are ergonomics. If you find a control that rests only on them, that is a bug and
   we want to hear about it.
