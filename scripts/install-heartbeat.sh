#!/bin/bash
# Install the superbot2 heartbeat as a background service (default every 30 min).
# Cross-platform via scripts/service-helper.sh: launchd on macOS, systemd --user
# timer (or supervisor-loop fallback) on Linux/WSL.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_DIR/scripts/heartbeat-cron.sh"
SUPERBOT2_HOME="${SUPERBOT2_HOME:-$HOME/.superbot2}"
CONFIG_FILE="$SUPERBOT2_HOME/config.json"
LOG_DIR="$SUPERBOT2_HOME/logs"

# Default interval: 30 minutes (1800 seconds)
INTERVAL=1800

# Read interval from config if available
if [[ -f "$CONFIG_FILE" ]] && command -v jq &>/dev/null; then
  configured_minutes=$(jq -r '.heartbeat.intervalMinutes // empty' "$CONFIG_FILE" 2>/dev/null || true)
  if [[ -n "$configured_minutes" ]]; then
    INTERVAL=$((configured_minutes * 60))
    echo "Using configured interval: ${configured_minutes} minutes"
  fi
fi

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Ensure heartbeat script is executable
chmod +x "$SCRIPT"

# shellcheck source=service-helper.sh
source "$REPO_DIR/scripts/service-helper.sh"

SVC_PROGRAM=$'/bin/bash\n'"$SCRIPT"
SVC_LOG="$LOG_DIR/heartbeat.log"
SVC_ENV=$'SUPERBOT2_HOME='"$SUPERBOT2_HOME"$'\nSUPERBOT2_NAME='"${SUPERBOT2_NAME:-superbot2}"
service_install heartbeat "$INTERVAL"

echo "Heartbeat installed and loaded."
echo "  Script: $SCRIPT"
echo "  Interval: $((INTERVAL / 60)) minutes"
echo "  Logs: $LOG_DIR/heartbeat.log"
