#!/usr/bin/env bash
# Keeps a deployed checkout on main, and the service running what it holds.
#
# Run by cortana-update.service, every few minutes, as the user who owns the
# checkout. When main has moved it updates, installs, tests, restarts, and
# confirms the new process came up — and if any of that fails, it puts the
# previous version back and restarts that instead. Nothing here needs root: a
# polkit rule lets this one user restart this one service, and nothing else.
#
# What it relies on, all of it already true of the repository:
#
# - main only moves through pull requests whose required checks passed, and
#   cannot be force-pushed, so "main moved" means "a reviewed, tested commit
#   arrived" and a fast-forward is always possible.
# - the lockfile is frozen and pnpm's release-age policy applies, so an
#   install installs what was reviewed.
#
# The suite is run here as well as in CI because CI ran on somebody else's
# machine: a failure that only this one produces is exactly the one worth
# refusing to deploy.
#
# The whole script is one function called on the last line. `git merge` below
# rewrites this file while it runs, and bash reads a script as it goes; a body
# parsed before anything executes cannot be changed under the running process.

main() {
  set -euo pipefail

  local checkout="${CORTANA_CHECKOUT:-/opt/cortana}"
  local node_bin="${CORTANA_NODE_BIN:-/opt/node/bin}"
  local service="${CORTANA_SERVICE:-cortana.service}"
  local branch="${CORTANA_BRANCH:-main}"
  local confirm_seconds="${CORTANA_CONFIRM_SECONDS:-60}"

  export PATH="$node_bin:$PATH"
  cd "$checkout"

  # A person editing the deployment by hand is not overruled by a timer.
  if [ -n "$(git status --porcelain)" ]; then
    echo "the checkout has local changes; not updating until they are gone"
    git status --short | head -10
    return 0
  fi

  # Offline is ordinary for a home server, and is tried again in five minutes
  # rather than reported as a failed unit every time.
  if ! timeout 120 git fetch --quiet origin "$branch"; then
    echo "could not reach the remote; trying again next time"
    return 0
  fi

  local current target
  current="$(git rev-parse HEAD)"
  target="$(git rev-parse "origin/$branch")"
  [ "$current" = "$target" ] && return 0

  if ! git merge-base --is-ancestor "$current" "$target"; then
    # Cannot happen while main refuses force-pushes. If it does, a person
    # should look before anything runs.
    echo "origin/$branch is not ahead of $(short "$current"); refusing to move" >&2
    return 1
  fi

  echo "updating $(short "$current") → $(short "$target"): $(git log -1 --format=%s "$target")"

  rollback() {
    echo "putting $(short "$current") back" >&2
    git reset --quiet --hard "$current"
    pnpm install --frozen-lockfile --reporter=silent
  }

  git merge --quiet --ff-only "origin/$branch"
  if ! pnpm install --frozen-lockfile --reporter=silent; then
    echo "the install failed" >&2
    rollback
    return 1
  fi
  if ! pnpm -s vitest run --reporter=dot >/tmp/cortana-update-tests.log 2>&1; then
    echo "the suite failed on this machine; not deploying it" >&2
    tail -30 /tmp/cortana-update-tests.log >&2
    rollback
    return 1
  fi

  local since
  since="$(date '+%Y-%m-%d %H:%M:%S')"
  # Checked rather than left to `set -e`, which would end the run here with the
  # new code on disk and the old process running it: the one state in which a
  # later crash restarts into something nobody tested on this machine.
  if ! systemctl restart "$service"; then
    echo "could not restart $service — is the polkit rule installed?" >&2
    rollback
    return 1
  fi

  if started_since "$service" "$since" "$confirm_seconds"; then
    echo "now running $(short "$target")"
    return 0
  fi

  echo "$(short "$target") did not come up; the service said:" >&2
  journalctl -u "$service" --since "$since" -o cat --no-pager 2>&1 | tail -15 >&2
  rollback
  local again
  again="$(date '+%Y-%m-%d %H:%M:%S')"
  systemctl restart "$service"
  if started_since "$service" "$again" "$confirm_seconds"; then
    echo "back on $(short "$current")" >&2
  else
    echo "and $(short "$current") did not come up either; it needs a person" >&2
  fi
  return 1
}

short() { git rev-parse --short "$1"; }

# Whether the service logged that its kernel started, after `since`.
#
# The kernel says so only once every component has started — the bot
# included — so this is "the new version is serving", not merely "a process
# exists". Reading the journal needs membership of systemd-journal.
started_since() {
  local service="$1" since="$2" seconds="$3" waited=0
  while [ "$waited" -lt "$seconds" ]; do
    if journalctl -u "$service" --since "$since" -o cat --no-pager 2>/dev/null |
      grep -q '"msg":"kernel started"'; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

main "$@"
exit
