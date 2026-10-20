# Working material — photos in, video out, the web, and not starting over

**Status:** Proposed
**Date:** 2026-10-20
**Version target:** one minor release per step, cut by the maintainer

---

## What this is, and why it comes before M4's step 5

**What the agent can be given and what it can hand back.** First use made the
system reachable from a phone. Used for real work, the first thing missing is
material: a photo of a job is most of a post, a short vertical video is most of
a clip, and an answer about the world needs the world. The agent can read text
and write text, and that is all.

M4's remaining steps are about **who** does the work — delegation, workers, a
team. This is about **what the work can be made of**, and a team of specialists
that can only exchange sentences is a smaller improvement than one agent that
can take photos in and give a video back. The owner chose this order on
2026-10-20, and chose web search into it as a feature anyone running this
would want.

### The second exception, stated as the first one was

[RELEASING §2](../RELEASING.md) allows an exception only with a plan saying why
and what it does not start. Why is above. What it does not start: nothing of M5
— the notes in step 5 are not memory, and say so — and nothing of M7's module
host. The video step is a capability the kernel calls, built where the module
host will later pick it up, for the reason the Telegram channel was: a host
built for one consumer is the guess the M1 plan warned against. M4 resumes at
step 5 when this is done.

**The core still knows no domain.** Everything here is generic — photos,
files, a slideshow, notes, search. What a post for one particular business
should say lives in its owner's configuration, not in this repository.

## Definition of done

- [ ] A photo or an album sent from the phone reaches the agent **as images**,
      kept on the machine. The audit records what was sent by reference and
      hash, not by the bytes
- [ ] A restart — and every deploy is one — **continues the conversation**
      rather than starting a new one
- [ ] A reply can carry files back to the phone, and **only files the system
      holds**: what it was sent, or what it made. The agent names a file by its
      id, never by a path
- [ ] An action the agent asks for is **executed by the kernel after the policy
      engine decides it**, and its result goes back to the agent. A refused
      action never runs, and the loop is bounded
- [ ] Photos become a **vertical video with captions**, assembled by `ffmpeg`
      from stored photos with fixed arguments. **Nothing the model wrote reaches
      a command line**
- [ ] "Remember this" is a **note the owner approves on their phone** — the
      approval path exercised live for the first time — and the notes are there
      at every wake. No note is written without a yes
- [ ] Web search runs in a **disposable session that can do nothing but
      search**, and only its structured findings reach the main agent, marked as
      untrusted. A page that addresses the agent is measured not to move it
- [ ] **A week of making real posts with it is written down**

## The order of work

**1. Photos in.** A Telegram photo, or an album (one update per photo, joined
by its `media_group_id`), is downloaded into a media store in the data
directory and handed to the turn as images. The runner port's `turn` gains
images beside the text; the adapter sends them as image blocks. The audit keeps
each image's id and SHA-256, so what was said is recorded without the audit
becoming a photo library.

> **What the step found.** The provider sees what it is sent: a 16×16 red PNG
> built by the contract and handed through the adapter came back "Piros" from
> the real model. Two things would have failed silently. The port's images are
> an optional parameter, so the audit's wrapper and the adapter both compiled
> while dropping every photo — a test now pins each. And a photo is fetched
> as soon as it arrives but used only when its turn comes, so a failed
> download was an unhandled rejection, which the daemon answers by exiting;
> each fetch now settles to a value. An album keeps its place in the queue
> from its first photo, so a message sent after it is answered after it.

**2. Not starting over.** The provider keeps a session it can resume, and the
port starts carrying that: the agent's session is reopened with `resume` after
a restart instead of fresh. Small, and first-hand: every merge to `main` is a
deploy, and every deploy until now has been the agent forgetting the
conversation.

> **What the step found.** Continuing works across processes, measured with a
> control: a session not continued did not know a word told to an earlier one
> ("NONE"), and a new provider process continuing it by token did. The port's
> token is required rather than optional, so a wrapper that forgot it does not
> compile — the photos had taught that lesson a step earlier.
>
> **A lost conversation had to be told apart from a failed turn**, because
> only the first is a reason to start afresh. Measured: the provider reports a
> session it no longer has as the same subtype many failures share, with the
> real reason in an `errors` field the adapter had never read. It reads it now,
> says what the provider said for every failure, and names exactly this one
> `resume-failed`. The kernel starts afresh on that code only, and asks the
> message again of the new conversation so it is not lost; any other failure
> keeps the conversation. `/new` sets it aside on purpose, because a
> conversation continued forever is one that grows in cost forever.

**3. Files out.** The agent's answer gains `attachments`: ids from the media
store. The Telegram channel sends them as photos, videos or documents; the
socket prints where they are. An id the store does not hold is refused, which
is the whole containment — there is no path for the model to name.

**4. Actions that run, and the first one.** Until now the agent's `actions` are
decided and dropped. Here the kernel gets a small registry of tools — a name, a
schema for its input, what it touches, and the function that does it — and
**runs what the policy engine allows**, then gives the result back to the agent
for one more turn, a bounded number of times. The first tool is
`make_slideshow`: stored photos, an order, a caption and a duration for each,
into a 1080×1920 H.264 video without audio — sound is added on the platform,
as decided at the start. Captions go to
`ffmpeg` through files rather than through its argument string, so no caption
text is ever parsed as a filter.

**5. Notes.** `remember` and `forget` are tools; notes live in the database and
are composed into the agent's prompt at every wake. Writing one is a write, so
under `confirm = "writes"` it is **put to the owner** — on the phone, as two
buttons — which is the approval path's first live use. A note is a short line,
and the list is capped. This is not M5: nothing is retrieved, everything is
always there, and that is affordable only because there is little of it.

**6. Web search.** `web_search` is a tool whose executor is a **disposable
session** — the researcher — granted `WebSearch` and nothing else: no memory,
no conversation, no paths, no `WebFetch`. It answers with structured findings
and their sources, and the main agent receives them quoted as untrusted
content. That is ADR-0007's quarantine applied to the web: the session that
read the pages could do nothing, and only its verdict travels on. The residual
risk is named rather than assumed away: a finding can carry an instruction in
its wording, and the measurement is a page written to steer the agent, run
against the whole loop.

**7. Assembly, and a week of making things.** Listed from the start, as M4's
was.

## The decisions it could not avoid

### 1. Files live in a store and are named by id

The agent never names a path — not for an attachment, not for a tool's input.
The store hands out ids for what it holds, and a tool takes ids and returns
ids. [ADR-0021](../adr/0021-containment-is-an-allowlist-applied-to-every-call.md)
made the tool list an allowlist; this makes the file list one, for the same
reason: a path a model chose is a path someone else can talk it into.

### 2. Notes are not memory, and are capped

M5 is retrieval over everything the system has seen, and is blocked on a corpus
for good reason. A short, owner-approved list that is always loaded needs none
of that, and is useful today. The cap keeps "always loaded" honest: the day the
list wants to be long is the day it should be M5.

### 3. The researcher is the quarantine for the web

ADR-0007 says fetched web pages go to an agent with no memory, no tools and no
way out. The researcher has one tool, `WebSearch`, which runs on the provider's
side — this machine opens no connection for it — and nothing else. It does not
get `WebFetch`, which fetches from this machine and is an egress channel the
profile could not yet close (the open question `settingsFor` refuses on).

## What it does not build

| Not here | Why |
|---|---|
| Hiding number plates and VINs automatically | Needs a detector that is right every time; a missed plate is a published plate. Measured before it is built |
| Generating images | A second model provider, its credential, and its cost per image |
| Posting anywhere | It drafts; the owner posts. Platform approval processes decide when that can change |
| Sound, music, narration | Out of scope since the beginning; added on the platform |
| `WebFetch`, and every other tool | One at a time, each with its own containment question |
| The team | M4, from step 5 — with delegation intersected, as decided on 2026-10-20 |

## Risks

- **Images are expensive context.** A photo is on the order of a thousand
  tokens, an album ten times that, and a resumed session carries them until
  it is compacted. Dormancy and resumption pull in opposite directions here,
  and the audit's cost figures are where it shows.
- **`ffmpeg` parses whatever it is given.** It is given only what the owner
  sent, past the allowlist, and runs under the service's hardening with a time
  limit. That is narrower than "untrusted input", and not nothing.
- **A tool that runs is a new kind of mistake.** Until step 4 a wrong action
  was a sentence; after it, it is an effect. Every tool declares what it
  touches, the policy engine decides on that, and a refusal is tested to never
  run.
- **The web can still speak through a summary.** The researcher can do nothing,
  but its findings are words the main agent reads. Notes need a yes and the
  main agent has no other tools that act, which bounds what a sentence can do;
  step 6's measurement is what says whether that is enough.
