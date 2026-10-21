# 0022. What the kernel does for an agent is decided on what it declares, and touches files by id

**Status:** Accepted
**Date:** 2026-10-21

## Context

Until [working material](../milestones/working-material.md)'s step 4, an
action an agent declared was decided by the policy engine and then dropped:
the decision was recorded, and nothing happened. The first action the kernel
actually runs — `make_slideshow`, photos into a captioned video by `ffmpeg` —
is the first time a wrong decision is an effect rather than a sentence, and
every later action (notes, web search, whatever a module contributes) is built
on the same path. Four questions had to be answered once, for all of them.

**Which list governs an action.** A profile already had `tools`, and the M3
schema had matched an action's fields to `ToolRequest` so they could be decided
the same way. But `tools` is the provider's vocabulary: it becomes the
allowlist the provider is handed ([ADR-0021](0021-containment-is-an-allowlist-applied-to-every-call.md)).
Putting `make_slideshow` in it would hand the provider a name that means
nothing to it, and let a name mean one thing in one place and another
elsewhere.

**Whose account of the action is believed.** The agent's intent carries
`writes` and `network`. They are the model's words about its own request, and
the model is the party the decision exists to check.

**What reaches the action.** An action's input is whatever the model wrote.

**What reaches a program.** `ffmpeg` reads its filter syntax from its
arguments, and a caption is a model's text with colons, quotes and brackets in
it.

## Decision

**An action is decided on what it declares, and touches only what the
system names.**

1. **Actions are their own allowlist.** `profile.actions` lists what the kernel
   may be asked to do; `profile.tools` lists what the provider may give the
   session. A name in one grants nothing in the other, in either direction, and
   `decideAction` checks `actions` and nothing else. Absent means none.
2. **The declaration is what is decided on.** An action states whether it
   writes and whether it reaches the network, and the request the policy
   engine sees is built from that. The model's own fields are not consulted.
3. **The action's schema is the input.** Input arrives as JSON in a string, is
   parsed, and is validated by the action's schema; the action is handed only
   the value the schema accepted, so a field the model added never reaches it.
   Input that does not fit never runs.
4. **Files are named by id wherever a model is involved** — what it is sent,
   what it attaches, what an action takes and makes. The media store is the one
   place an id becomes a path, and only system code asks it to.
5. **A model's text never reaches a command line.** What a program must read of
   it — a caption — goes through a file the system wrote, with the program's own
   interpretation of the text switched off (`expansion=none`). Paths written
   into a filtergraph are refused, not escaped, unless they are ones this code
   made.
6. **An action always comes back as a sentence**, and one message runs at most
   three rounds of actions. A thrown defect's details go to the log, not to the
   model.

## Consequences

- **A wrong action is bounded by its declaration and its schema**, not by what
  the model believed about it. A model that calls a write a read is still asked
  about under `confirm = "writes"`; a model that adds `"path"` to a slideshow's
  input adds nothing.
- **The configuration offers actions explicitly** (`agent.actions`, empty by
  default), the way it offers tools.
- **The answer schema carries every action's input as a string.** One schema
  for all actions is what the provider's fixed session shape allows; the cost
  is that the model writes JSON inside a string, and the action's own schema is
  what keeps that honest.
- **Programs are fed files the system wrote, never model text.** The slideshow
  measured it: a caption of `kész' [x]; %{eif:1:d} \` rendered as those
  characters, and no argument contained them.
- What an action makes is sent with the reply whether or not the agent attached
  it.

## Alternatives considered

**Actions in `tools`.** Rejected: the provider's allowlist would carry names it
cannot use, and one list would hold two vocabularies with different enforcement.

**The model's declaration of effects.** Rejected: the declaration is the model
describing its own request to the check that exists because of it.

**A typed input per action in the answer schema.** Stronger for the model, and
it would make the session's output shape depend on which actions exist — which
the port fixes for a session's life. Not rejected, deferred: if the JSON-in-a-
string input proves error-prone, this is the remedy.

## Revisit when

An action needs the network — web search is the first, and runs in a session
of its own rather than through the main profile's `network` — or the module
host (M7) lets a module contribute actions, at which point a module's
declaration is something the host has to be able to check rather than trust.
