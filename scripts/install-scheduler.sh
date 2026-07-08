#!/bin/bash
# Install the superbot2 scheduler as a background service (checks every 60s).
# Cross-platform via scripts/service-helper.sh: launchd on macOS, systemd --user
# timer (or supervisor-loop fallback) on Linux/WSL.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_DIR/scripts/scheduler.sh"
SUPERBOT2_HOME="${SUPERBOT2_HOME:-$HOME/.superbot2}"
LOG_DIR="$SUPERBOT2_HOME/logs"

# Resolve node's real binary path and save it for LaunchAgent scripts.
# LaunchAgents run in a minimal environment without the user's shell profile,
# so we capture the real node location now while we have access to it.
# Handles: Homebrew (ARM + Intel), asdf, nvm, volta, fnm, system installs.
REAL_NODE=""
if command -v asdf &>/dev/null; then
  REAL_NODE=$(asdf which node 2>/dev/null)
elif command -v volta &>/dev/null; then
  REAL_NODE=$(volta which node 2>/dev/null)
elif command -v fnm &>/dev/null; then
  REAL_NODE=$(fnm exec --using=default -- which node 2>/dev/null)
fi
if [[ -z "$REAL_NODE" ]]; then
  NODE_BIN=$(command -v node 2>/dev/null)
  [[ -n "$NODE_BIN" ]] && REAL_NODE=$(readlink -f "$NODE_BIN" 2>/dev/null || realpath "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")
fi
if [[ -n "$REAL_NODE" ]]; then
  echo "$(dirname "$REAL_NODE")" > "$SUPERBOT2_HOME/.node-path"
fi

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Ensure scheduler script is executable
chmod +x "$SCRIPT"

# shellcheck source=service-helper.sh
source "$REPO_DIR/scripts/service-helper.sh"

SVC_PROGRAM=$'/bin/bash\n'"$SCRIPT"
SVC_LOG="$LOG_DIR/scheduler.log"
SVC_ENV=$'SUPERBOT2_HOME='"$SUPERBOT2_HOME"$'\nSUPERBOT2_NAME='"${SUPERBOT2_NAME:-superbot2}"
service_install scheduler 60

echo "Scheduler installed!"
echo "  Checks every 60 seconds"
echo "  Config: schedule array in $SUPERBOT2_HOME/config.json"
echo "  Log: $LOG_DIR/scheduler.log"
