#!/bin/bash
# Tear down the M1 satellite runner LaunchAgent.
# Leaves logs in place; remove them by hand if you want.

set -euo pipefail

LABEL="staqs.optimus.runner"
TARGET_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
SERVICE="$DOMAIN/$LABEL"

if launchctl print "$SERVICE" >/dev/null 2>&1; then
  echo "[uninstall] booting out $LABEL"
  launchctl bootout "$SERVICE" || true
fi

if [[ -f "$TARGET_PLIST" ]]; then
  echo "[uninstall] removing $TARGET_PLIST"
  rm "$TARGET_PLIST"
fi

echo "[uninstall] done. logs preserved at ~/Library/Logs/staqs-optimus-runner.{log,err}"
