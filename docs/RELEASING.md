# Branching, versioning, and releasing

The rules for how code gets into `main` and how `main` becomes a release. They are
written down because a convention that lives only in the maintainer's head stops
being a convention the moment a second person shows up.

---

## 1. Branching

**Trunk-based, with short-lived branches.**

```
main ──●──────●──────●──────●──────●──▶   always green, always releasable
        \    /        \    /
         ●──●          ●──●               feat/…  fix/…  short-lived
```

| Rule | |
|---|---|
| `main` is always green | A red `main` is an emergency and takes priority over any other work |
| `main` is always releasable | Whatever is on `main` could be tagged right now without embarrassment |
| Branches are short-lived | Days, not weeks. A long branch is a merge conflict accruing interest |
| Everything lands through a pull request | Including the maintainer's own work — see below |
| No long-lived `develop` branch | GitFlow solves a problem this project does not have and creates permanent merge debt |

Branch names follow the commit type: `feat/agent-roster`, `fix/queue-lease-expiry`,
`docs/adr-quarantine`, `chore/bump-biome`.

### Why the maintainer uses pull requests too

It looks like ceremony for a solo project, and there is one concrete reason it is
not: **the DCO sign-off check only runs on pull requests.** Work pushed straight
to `main` never has its sign-off verified. A rule that is documented but
unenforced erodes, and it erodes fastest when the person skipping it is the one
who wrote it.

Merges are **squash merges**, and the squash commit message must be a valid
Conventional Commit, because that message is what drives versioning (§2).

## 2. Versioning

**Semantic Versioning**, with pre-release identifiers.

### Before 1.0.0

```
0.MINOR.PATCH
```

While the major version is `0`, **the public interface is not stable**. Breaking
changes bump `MINOR`. This is normal for pre-1.0 software and is stated here so
nobody has to guess.

### Pre-release stages

```
0.1.0-alpha.1  →  0.1.0-beta.1  →  0.1.0-rc.1  →  0.1.0
```

Each stage is a promise about what the build is fit for. They are not decoration.

| Stage | What it means | Who should run it |
|---|---|---|
| **alpha** | The feature exists and works on the maintainer's machine. May lose data. No upgrade path — expect to delete the database. | The maintainer, and nobody else |
| **beta** | Feature-complete for that milestone. No known data loss. Migrations exist and are tested. Interfaces may still change. | Early adopters who accept that it will break |
| **rc** | No known blocking defects. Documentation is current. Would ship as final if nothing surfaces. | Anyone willing to report bugs |
| **stable** | No qualifier. It is done. | Anyone |

**Nothing is promoted a stage on optimism.** A build moves from alpha to beta
because migrations exist and were tested, not because it feels ready.

### What 1.0.0 will mean

`1.0.0` is not "we have been at it a while". It is a specific commitment, and
until all four are true the version stays below it:

1. **The configuration format is stable.** An upgrade does not require editing
   config by hand.
2. **The module interface is stable.** A connector or pack written against 1.0
   keeps working across 1.x.
3. **Migrations are guaranteed forward.** Upgrading never asks you to delete data.
4. **The security model has been reviewed against the threat model**, including
   the quarantine boundary in [ADR-0007](adr/0007-quarantine-untrusted-content.md),
   with a spike proving it holds rather than a claim that it does.

After 1.0.0, breaking either of the first two requires a major bump.

### Milestones and versions

The build order from the design maps onto versions like this. It is a plan, not a
contract — a milestone that turns out to need two releases gets two.

| Milestone | Contents | Target |
|---|---|---|
| M1 | Kernel skeleton: config, storage, migrations, writer queue, logging, service unit, graceful shutdown | `0.1.0-alpha` → `0.1.0` |
| M2 | Model runner port and adapter, audit pipeline, cost tracking | `0.2.0` |
| M3 | Chat channel, conversation loop, approvals | `0.3.0` |
| M4 | Memory: schema, embeddings, hybrid retrieval, tuning from measurement | `0.4.0` |
| M5 | Scheduler, durable jobs, the proactive gate, budget governor | `0.5.0` |
| M6 | Dashboard, ops CLI, second runner adapter, packaging | `0.6.0` → `1.0.0-rc` |

**No milestone starts before the previous one's definition of done is met.** The
characteristic failure of a project like this is a broad, shallow, half-working
surface. A working M1 beats six half-built milestones.

## 3. Tags

Every release is an **annotated, signed** tag: `v0.1.0-alpha.1`.

- Annotated, not lightweight — a release should carry a message, an author, and a
  date
- Signed, because commits are signed and a tag that is not is the weak link
- Prefixed `v`, matching the ecosystem convention
- **Never moved, never deleted.** A tag is a claim about what existed at a moment.
  If a release is wrong, the fix is the next version, not a rewritten past.

## 4. How a release actually happens

Releases are driven by [release-please](https://github.com/googleapis/release-please),
which reads Conventional Commits on `main`.

1. Work merges to `main` as usual.
2. release-please opens or updates a **release pull request** with the version
   bump and the generated `CHANGELOG.md` entry.
3. The maintainer reviews it. This is the checkpoint: a wrong commit type produces
   a wrong version bump, and this is where it gets caught.
4. Merging that pull request creates the tag and the GitHub Release.

### Forcing a specific version

Stage transitions are not something commit types can express, so they are stated
explicitly. Put a footer in any commit that should land in the release:

```
Release-As: 0.1.0-beta.1
```

This is how `alpha` → `beta` → `rc` → stable progression happens: deliberately,
by a person deciding the build has earned it.

### Which commit types affect the version

| Type | Effect | In the changelog |
|---|---|---|
| `feat` | MINOR | Features |
| `fix` | PATCH | Bug fixes |
| `perf` | PATCH | Performance |
| `refactor`, `docs`, `test`, `build`, `ci`, `chore` | none | grouped or hidden |
| any type with `!` or a `BREAKING CHANGE:` footer | MINOR pre-1.0, MAJOR after | Breaking changes, always shown |

## 5. What each release must include

A release is not just a tag.

- [ ] CI green on every supported platform
- [ ] `CHANGELOG.md` entry that a user can act on — what changed and what it means
      for them, not a list of commit subjects
- [ ] **Migration notes if the database schema changed**, including whether an
      alpha user has to start over
- [ ] Documentation current. Stale documentation is worse than none
- [ ] Pre-releases marked as pre-release on GitHub, so nobody installs one by
      accident
- [ ] Security-relevant changes called out explicitly, not buried under "fixes"

## 6. Repository settings

These are configured in GitHub rather than in the repository, so they are recorded
here to survive the memory of whoever set them up.

**Branch protection on `main`:**
- Require a pull request before merging
- Require status checks to pass: `verify (ubuntu-latest)`, `verify (macos-latest)`,
  `privacy guard`, `DCO sign-off`
- Require branches to be up to date before merging
- Require signed commits
- Require conversation resolution before merging
- Do not allow force pushes; do not allow deletion

**Tag protection:** `v*` — nobody deletes or moves a release tag.

**Merge settings:** squash merge only. Disable merge commits and rebase merging,
so the commit that lands on `main` is always the one release-please reads.

## 7. Security releases

A fix for a reported vulnerability ships **on its own**, not bundled with
unrelated work, so that users can upgrade with minimal risk of taking on anything
else. It is announced through a GitHub Security Advisory, and the reporter is
credited if they want to be. See [SECURITY.md](../SECURITY.md).
