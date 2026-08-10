# 0004. Implement orchestration ourselves

**Status:** Accepted
**Date:** 2026-08-10

## Context

The upstream agent runtime ships a coordination feature: several agent instances
with a shared task list and a mailbox, one acting as lead. On paper it is exactly
what this project needs, and adopting it would remove a large amount of work.

Reading its documentation rather than its summary changed the assessment. As
documented, it is **experimental and disabled by default**, and it carries
limitations that are individually reasonable for interactive use and individually
disqualifying for a daemon:

- **No session resumption.** After a restart the lead may try to message
  teammates that no longer exist. For a process expected to run for months across
  reboots, this is not a rough edge; it is the central requirement failing.
- **One team per session**, and **no nested teams**.
- **The lead is fixed** for the session's lifetime.
- Task status can lag, blocking dependent work.
- Coordination state lives in files under the user's home directory rather than
  in our transactional store, so it cannot participate in our recovery or audit.

The adjacent feature — direct messaging between independent sessions — is more
mature, but it carries **plain text only**, caps queued messages per session, and
throttles repeats. It cannot carry a structured task assignment, a status object,
or a verdict.

## Decision

**We implement the coordination layer: the roster, delegation, the task model,
the message bus, and report aggregation.** Upstream coordination features are not
in the dependency path.

Two upstream capabilities *are* adopted, because they sit below the coordination
layer rather than replacing it:

- **Subagents**, for ephemeral workers inside a task — see
  [0005](0005-hybrid-execution-topology.md).
- **The per-session inbox socket**, as one transport for injecting a message into
  a running session from outside.

## Consequences

- Behaviour is predictable and debuggable, and coordination state is in the same
  transactional store as everything else, so recovery and audit are uniform.
- Messages between agents can be **structured**, which the upstream transport
  cannot carry. Task assignments and verdicts are typed objects, not prose.
- **Significantly more code**, and it is the code most likely to contain subtle
  bugs. The durable queue, envelope handling, and the policy engine are called out
  in `CONTRIBUTING.md` as requiring tests for exactly this reason.
- We do not benefit automatically when upstream improves its version.

## Alternatives considered

**Adopt the upstream team feature.** Rejected on session resumption alone. A
personal assistant that forgets its team on reboot is not a personal assistant.

**Use cross-session messaging as the bus.** Rejected: plain text only, message
caps, throttling, and it does not work across container filesystem boundaries.
Adopted as *a* transport, not as *the* bus.

**Wait for it to stabilise.** Rejected — that is a decision to build nothing
while waiting on someone else's roadmap.

## Revisit when

The upstream feature leaves experimental status **and** supports session
resumption. Both, not either.
