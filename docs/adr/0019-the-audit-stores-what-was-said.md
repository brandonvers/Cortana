# 0019. The audit stores what was said, and the documentation says so

**Status:** Accepted
**Date:** 2026-09-01

## Context

[CONCEPTS §10](../CONCEPTS.md) makes the audit store the kernel's responsibility
and describes its contents in one line: "every prompt, tool call, decision, and
cost, correlated". Taken literally — and it should be taken literally, because
that is what makes it an audit rather than a metrics table — that is a complete
record of everything the operator ever said to the system, and everything it said
back, on their disk.

Nothing about that is accidental. An audit trail exists to answer *why did it do
that*, and an answer is not reconstructible from a hash. But it has consequences
that are easy to leave unstated until somebody discovers them, and three of them
interact with decisions already made:

- **[ADR-0018](0018-secrets-at-rest.md)'s `Secret` type cannot help here.** It
  keeps a credential out of a log line by closing every route from an object to
  text. A prompt is not an object being formatted — it is what the operator
  typed. If they paste a password into a message, the audit records a password.
- **[ADR-0010](0010-sqlite-storage.md) put everything in one file**, deliberately,
  so there is one backup and one recovery story. That file now contains the
  transcript, and so does every copy of it.
- **"Forever" is a decision, not a default.** On a machine that runs for years,
  an unbounded audit is a choice to keep the record until the disk decides
  otherwise — which moves the decision to the least convenient moment.

## Decision

**The audit stores prompts, responses, tool calls and costs in full**, and the
documentation states plainly that the database contains them.

**Retention is a configured number of days, not "forever".** The default is 90 —
long enough to investigate something that happened last quarter, short enough
that a home server's disk is not the thing that eventually decides. Keeping
everything remains available and has to be written down to take effect.

**Deleting is part of the design rather than an operational afterthought.**
Expiry runs as ordinary work through the writer, in the same transaction
discipline as everything else.

## Consequences

- **The audit can answer the question it exists for.** Why an agent did something
  is reconstructible from what it was asked and what it was told, which is not
  recoverable from metadata.
- **The database is sensitive by construction, and its protection is whatever the
  filesystem provides.** M1 creates the data directory `0700`; nothing encrypts
  the file. ADR-0018's ladder protects *credentials handed to the daemon*, not
  the transcript — those are different things and conflating them would overstate
  both.
- **A backup carries the transcript.** Anyone documenting a backup procedure has
  to say so, and this is the record that they must.
- **The retention window is a real deletion**, so an investigation that starts too
  late finds nothing. That is the trade being made deliberately, and the number is
  the operator's to change.
- **Nothing redacts prompts.** Pattern-matching for credentials would be lossy in
  both directions — removing what was needed, keeping what was not — and would
  create a false impression that the store is safe to share. It is not; it is
  safe to keep.

## Alternatives considered

**Metadata and hashes only, without the text.** No transcript ever on disk.
Rejected: it produces an audit trail that cannot explain a single decision, which
is the whole purpose. A hash tells you two prompts differed, not why the answer
was wrong.

**Unbounded retention.** Simplest, and keeps the most. Rejected because it is not
actually a choice to keep everything — it is a choice to defer the deletion
decision to the day the disk fills, when it will be made in a hurry and probably
with `rm`.

**Encrypting the audit at rest.** Rejected for the reason ADR-0018 already gives
about a key sitting beside the thing it protects: a daemon that must read its own
audit unattended has to hold the key, so the encryption protects against a threat
model nobody has described. Filesystem permissions are the honest boundary, and
saying so is worth more than a feature that sounds like protection.

**Letting the operator opt out of storing prompts.** Attractive, and rejected for
now as a setting with no user: it doubles the number of states every later feature
has to reason about — a report that cannot cite its own evidence, a governor that
cannot explain a cost — before anyone has asked for it. If someone does, it is a
small change and this is the record of why it was not made first.

## Revisit when

Someone runs this in a setting where the transcript is not solely theirs — a
shared machine, or a second person's data passing through a connector. The
decision above rests entirely on the operator being the subject of the record as
well as its owner, and that assumption is worth checking rather than inheriting.
