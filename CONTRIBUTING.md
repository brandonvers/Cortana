# Contributing to Cortana

Thank you for considering it. This document covers the setup, the rules, and how decisions get
made here.

> **Current status: pre-alpha.** There is no working software yet, and the architecture is
> still settling. The most useful contributions right now are review of the design in
> `docs/CONCEPTS.md` and `docs/adr/`, and disagreement with it where you have grounds.

## Getting set up

You need **Node.js ≥ 24.12** (the version in `.nvmrc`) and **pnpm ≥ 11**.

```bash
git clone https://github.com/brandonvers/Cortana.git
cd Cortana

nvm use                 # or fnm use / volta — anything that reads .nvmrc
npm install -g pnpm@11  # if you do not have pnpm 11 yet

pnpm install
pnpm run verify         # lint, typecheck, test, licence check, privacy check
```

`pnpm run verify` is exactly what CI runs. If it passes locally it will pass there.

Individual steps:

| Command | What it does |
|---|---|
| `pnpm run lint` | Biome — lint and format check |
| `pnpm run format` | Biome — apply fixes |
| `pnpm run typecheck` | `tsc --noEmit` |
| `pnpm run test` | Vitest, once |
| `pnpm run test:watch` | Vitest, watching |

**A stranger should be able to run the test suite within fifteen minutes of cloning, on a fresh
machine, following only this file.** If that was not your experience, that is a bug worth
reporting.

## Ground rules for the code

### TypeScript must be erasable

Node runs our `.ts` files directly using type stripping, which can only remove syntax that
erases to nothing. `erasableSyntaxOnly` is on, so the compiler rejects anything that would not
survive it:

- no `enum` — use a union of string literals, or `as const` objects
- no `namespace`
- no constructor parameter properties (`constructor(private readonly x: T)`)
- `import type` / `export type` for type-only imports (`verbatimModuleSyntax` is on)

### Module boundaries are enforced

- `kernel` may depend on anything; **nothing may depend on `kernel`**
- `core` and `db` depend on no other internal package
- **only `runner-claude` may import Claude Code or Agent SDK types.** Everything else talks to
  the `ModelRunner` port. This is what lets the project survive an upstream change or a policy
  change at the provider, and CI enforces it.

### No security property may rest on frontmatter

Tool allowlists in agent or skill frontmatter are ergonomics, not a boundary. If you write a
control that holds only because a YAML field says so, it will be rejected in review.

Every security property is enforced twice, but **the second layer depends on what the tool is**,
and naming the wrong one rejects the only control that works:

- **Spawned commands**: the policy engine and the OS sandbox, with
  `sandbox.autoAllowBashIfSandboxed: false` — at the default, a sandboxed command needs no
  permission decision and the policy engine is not in its path at all
  ([spike 0012](docs/spikes/0012-bash-read-channel.md)).
- **In-process tools** (Read, Write, Edit, WebFetch, MCP dispatch): the policy engine's allow
  decision and a **path-scoped `permissions.deny` rule**. The OS sandbox does not reach them
  ([spike 0010](docs/spikes/0010-non-bash-containment.md)).

A deny rule must be written `Read(//abs/path/**)`. The single-slash form `Read(/abs/path/**)`
leaked 4 times out of 4 in [spike 0011](docs/spikes/0011-quarantine-escape.md), raises no error,
and leaves a profile looking protected with one layer.

### Nothing clever without a comment explaining the cleverness

And if understanding one function requires reading three files, restructure it.

## Dependencies

**Every new dependency is discussed before it is added.** Open an issue first. A PR that adds a
dependency without prior discussion will be asked to justify it, which is slower for everyone.

What the discussion needs to cover:

- **What it is for**, in one sentence
- **Licence** — must be compatible with MIT. **AGPL, SSPL, and source-available licences are
  disqualifying.** Check, do not assume.
- **Maintenance health** — last release, open issue trend, how many people can merge
- **Native module implications** — anything requiring compilation must build on Linux x86_64
  and macOS arm64
- **Whether it is actually needed.** The best dependency is often none. But do not hand-roll
  what a well-maintained standard solves: writing your own cron parser, schema validator, or
  retry logic is a maintenance liability, not craftsmanship.

`pnpm run check:licenses` runs in CI and fails the build on a disallowed licence.

## Spikes

Anything version-sensitive or externally dependent gets verified before it is designed around.

- A spike lives in `spikes/NN-name/` and is **throwaway**. It is never merged into `packages/`.
- Its **pass criterion is written down before it runs**, not after.
- Its result goes in `docs/spikes/NN-name.md`: what was tested, exact versions, what happened,
  the verdict, and **what it changes in the architecture**.
- **A spike that invalidates part of the design is a success**, not a setback. Say so plainly.

## Decisions

Significant decisions are recorded as ADRs in `docs/adr/NNNN-title.md`. This is how a
contributor learns *why*, not just *what*, and how settled questions stay settled.

Write one when a decision would be expensive to reverse, when a reasonable person would have
chosen differently, or when you find yourself explaining the same reasoning twice.

An ADR that turns out to be wrong is not edited into looking right. Write a new one that
supersedes it and say what changed.

## Commits and pull requests

### Sign your commits off (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/)
rather than a CLA. Signing off means you certify you have the right to submit the code under
the project's licence.

```bash
git commit -s -m "feat(memory): add trigram index for inflected languages"
```

That adds `Signed-off-by: Your Name <your@email>` to the message. CI checks for it.

### Conventional Commits

```text
<type>(<scope>): <subject>

<body — explain WHY, not what; the diff already says what>

Signed-off-by: Your Name <your@email>
```

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`,
`revert`. A breaking change takes a `!` before the colon, or a `BREAKING CHANGE:`
footer.

**These types are not decoration — they drive the version number.** `feat` bumps
the minor, `fix` bumps the patch, and a breaking marker does something larger.
See [docs/RELEASING.md](docs/RELEASING.md).

Keep commits small and atomic. One idea per commit.

### Pull requests

Everything lands through a pull request, including the maintainer's own work.
That is not ceremony: the DCO check only runs on pull requests, so anything
pushed straight to `main` never has its sign-off verified.

Merges are **squash merges**, and the pull request title becomes the commit
message on `main`. That message drives the version bump and the changelog entry,
so **the title must itself be a valid Conventional Commit**. CI checks it.

- Branch from `main`, named for the change: `feat/agent-roster`,
  `fix/queue-lease-expiry`
- Keep it short-lived. A long branch is a merge conflict accruing interest
- `pnpm run verify` must pass before you open it
- Every non-trivial module needs tests. Especially the durable job queue, envelope handling,
  the policy engine, and memory retrieval — that is where silent bugs cost the most.
- Explain the *why* in the description, and link the issue or ADR
- **A red `main` is an emergency.** If your merge breaks it, fixing it comes before anything
  else.

## The private directory

`private/` is gitignored, blocked by a pre-commit hook, and checked again in CI. It holds the
maintainer's personal notes and packs. You will not see it and you do not need it — anything
required to understand or extend the project lives in the public `docs/`.

If you are working from a fork and want your own private material alongside the code, that
directory is there for you too and will never be committed.

## Releases

You do not need to touch versions, tags, or the changelog — all three are
generated from commit messages, which is why the commit type matters.

If you want to know what a version number means before you install one, or what
`1.0.0` will commit to, that is all in [docs/RELEASING.md](docs/RELEASING.md).
The short version: while the major version is `0`, the interface is not stable,
and `alpha` means "may lose your data".

## Code of Conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Disagreement is welcome

If you think a design decision is wrong, say so and argue for the alternative. Deference that
produces a worse system is not politeness. Bring the reasoning, and it will be met with
reasoning.
