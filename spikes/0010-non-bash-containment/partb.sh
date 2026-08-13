#!/usr/bin/env bash
#
# Spike 0010, Part B — the only channel that honours `sandbox.bwrapPath`.
#
# Part 0 established that the SDK `managedSettings` option drops `bwrapPath`
# through its restrictive-key filter, so the substitution spike 0008 recommended
# for itself is unreachable from an embedding. The typings name one remaining
# channel: an admin-controlled /etc/claude-code/managed-settings.json.
#
# This script is the only part of the spike that needs root, and root is used
# for exactly one thing: putting that file in place and taking it away again.
# The probe itself runs as the invoking user, because it needs that user's
# Claude Code login. No credential is read, moved, or copied by this spike.
#
# ---------------------------------------------------------------------------
# READ THIS BEFORE RUNNING
#
# While the file exists, EVERY Claude Code process on this machine resolves a
# sandbox whose binary points at a path that does not work. That includes any
# interactive session you have open. The window is a few model turns; the trap
# below removes the file on any exit, including Ctrl-C and failure, and restores
# whatever was there before. If the machine dies mid-run, delete it by hand:
#
#   sudo rm -f /etc/claude-code/managed-settings.json
#   sudo mv /etc/claude-code/managed-settings.json.spike0010.bak \
#           /etc/claude-code/managed-settings.json   # only if a backup exists
# ---------------------------------------------------------------------------
#
# Usage:  sudo ./partb.sh

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MANAGED_DIR=/etc/claude-code
MANAGED=$MANAGED_DIR/managed-settings.json
BACKUP=$MANAGED.spike0010.bak
SHIM=/tmp/spike0010-bwrap-shim
SHIM_MARKER=/tmp/spike0010-bwrap-ran

if [[ $EUID -ne 0 ]]; then
  echo "This needs root only to place /etc/claude-code/managed-settings.json." >&2
  echo "Re-run as: sudo ./partb.sh" >&2
  exit 1
fi

RUN_AS=${SUDO_USER:-}
if [[ -z $RUN_AS ]]; then
  echo "SUDO_USER is empty — the probe must run as the logged-in user, not root," >&2
  echo "because it needs that user's Claude Code session. Use sudo, not a root shell." >&2
  exit 1
fi

# `sudo -u` switches the uid but leaves HOME pointing at root's, so the CLI would
# look for a session that is not there and every arm would fail for a reason that
# has nothing to do with the sandbox. Resolve the real home explicitly.
RUN_HOME=$(getent passwd "$RUN_AS" | cut -d: -f6)
if [[ -z $RUN_HOME || ! -d $RUN_HOME ]]; then
  echo "Could not resolve a home directory for $RUN_AS." >&2
  exit 1
fi
if [[ ! -d $RUN_HOME/.claude ]]; then
  echo "WARNING: $RUN_HOME/.claude does not exist — $RUN_AS may not be logged in." >&2
  echo "         Every arm would then fail for a reason unrelated to the sandbox." >&2
fi

HAD_BACKUP=0
cleanup() {
  rm -f "$MANAGED"
  if [[ $HAD_BACKUP -eq 1 ]]; then
    mv -f "$BACKUP" "$MANAGED"
    echo "restored the pre-existing managed-settings.json"
  fi
  rm -f "$SHIM" "$SHIM_MARKER"
  echo "cleaned up: $MANAGED removed"
}
trap cleanup EXIT

mkdir -p "$MANAGED_DIR"
if [[ -f $MANAGED ]]; then
  echo "NOTE: an existing managed-settings.json was found and is being set aside."
  cp -p "$MANAGED" "$BACKUP"
  HAD_BACKUP=1
fi

# An executable that fails when run. Spike 0008 wrote its shim executable too,
# which is why a presence check — access(X_OK) — would have passed without ever
# invoking it. The marker is what tells those two cases apart.
cat >"$SHIM" <<EOF
#!/bin/sh
touch $SHIM_MARKER
exit 1
EOF
chmod 0755 "$SHIM"

write_managed() {
  cat >"$MANAGED" <<EOF
{
  "sandbox": {
    "enabled": true,
    "bwrapPath": "$1",
    "failIfUnavailable": $2
  }
}
EOF
  chmod 0644 "$MANAGED"
}

# Each arm changes exactly one thing against the arm above it, so a difference
# in outcome has one candidate cause.
#
#   name                  bwrapPath              failIfUnavailable
run_arm() {
  local name=$1 path=$2 gate=$3
  echo
  echo "=== $name  (bwrapPath=$path, failIfUnavailable=$gate)"
  write_managed "$path" "$gate"
  rm -f "$SHIM_MARKER"
  # The marker must be world-writable-adjacent: the shim runs as whoever the CLI
  # spawns it as, while this check runs as $RUN_AS. /tmp with a fresh name is
  # enough, and it is removed between arms so a stale marker cannot be read as
  # this arm's evidence.
  sudo -u "$RUN_AS" env HOME="$RUN_HOME" SHIM_MARKER="$SHIM_MARKER" \
    node "$SCRIPT_DIR/partb.ts" "$name" || echo "  (probe exited non-zero)"
}

run_arm missing-gate-on   /nonexistent/bwrap "true"
run_arm missing-gate-off  /nonexistent/bwrap "false"
run_arm shim-gate-on      "$SHIM"            "true"
run_arm shim-gate-off     "$SHIM"            "false"

echo
echo "The paired control is the pair of arms above: the only difference within each"
echo "bwrapPath is failIfUnavailable. If both members of a pair behave identically,"
echo "the setting changed nothing — which is what two previous spikes assumed it did."
