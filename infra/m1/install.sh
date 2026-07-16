#!/bin/bash
# Install the M1 satellite runner as a LaunchAgent.
# Idempotent — safe to run repeatedly to pick up plist changes.
#
# Usage:  bash infra/m1/install.sh
# Status: launchctl print gui/$(id -u)/staqs.optimus.runner
# Restart: launchctl kickstart -k gui/$(id -u)/staqs.optimus.runner

set -euo pipefail

LABEL="staqs.optimus.runner"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/staqs.optimus.runner.plist.template"
TARGET_DIR="$HOME/Library/LaunchAgents"
TARGET_PLIST="$TARGET_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"

mkdir -p "$TARGET_DIR" "$LOG_DIR"
chmod +x "$SCRIPT_DIR/runner.sh"

# Render the template — substitute %HOME% with the operator's actual $HOME.
sed "s|%HOME%|$HOME|g" "$TEMPLATE" > "$TARGET_PLIST"

DOMAIN="gui/$(id -u)"
SERVICE="$DOMAIN/$LABEL"

# Bootout existing instance (if any) so a fresh bootstrap picks up plist changes.
if launchctl print "$SERVICE" >/dev/null 2>&1; then
  echo "[install] removing existing $LABEL"
  launchctl bootout "$SERVICE" 2>/dev/null || true
  sleep 1
fi

# Kill any stray manually-started runner.js processes to avoid duplicate claimers.
# Match the canonical agent set arg so we don't accidentally kill an unrelated
# tool that happens to mention 'runner.js'. Any previous launchd-managed job was
# torn down above, and the new one is only bootstrapped later, so it won't show
# in pgrep yet.
STRAYS=$(pgrep -f "src/runner.js --agents=" || true)
if [[ -n "$STRAYS" ]]; then
  echo "[install] killing stray runners: $STRAYS"
  # shellcheck disable=SC2086
  kill -TERM $STRAYS 2>/dev/null || true
  sleep 3
  # shellcheck disable=SC2086
  kill -KILL $STRAYS 2>/dev/null || true
fi

echo "[install] bootstrapping $LABEL"
launchctl bootstrap "$DOMAIN" "$TARGET_PLIST"

sleep 2
if launchctl print "$SERVICE" >/dev/null 2>&1; then
  PID=$(launchctl print "$SERVICE" | awk '/^\tpid =/{print $3}')
  echo "[install] OK — $LABEL running as PID ${PID:-unknown}"
  echo "[install] tail logs:  tail -f $LOG_DIR/staqs-optimus-runner.log"
  echo "[install] restart:    launchctl kickstart -k $SERVICE"
  echo "[install] status:     launchctl print $SERVICE"
  echo "[install] uninstall:  bash $SCRIPT_DIR/uninstall.sh"
else
  echo "[install] FAIL — service did not bootstrap. Check $LOG_DIR/staqs-optimus-runner.err"
  exit 1
fi
