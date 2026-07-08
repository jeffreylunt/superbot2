#!/bin/bash
# Install the orchestrator watchdog (system-level auto-restart for superbot2) as a
# macOS launchd agent. Jeff's ask: restart superbot2 if it crashes or stops working.
#
#   Install / reload:  bash scripts/install-orchestrator-watchdog.sh
#   Uninstall:         bash scripts/service-helper.sh uninstall orchestratorwatchdog
#
# Cross-platform via scripts/service-helper.sh (launchd on macOS; systemd --user /
# supervisor-loop on Linux/WSL). The watchdog needs: node (health probe), tmux (relaunch
# into a pane), jq (health JSON). launchd's (and systemd's) minimal PATH has NONE of these
# managers' dirs — resolve at install time and bake the dirs into the service PATH (same
# class of bug that dark-launched the wake-nudge).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_DIR/scripts/orchestrator-watchdog.sh"
SUPERBOT2_HOME="${SUPERBOT2_HOME:-$HOME/.superbot2}"
LOG_DIR="$SUPERBOT2_HOME/logs"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then echo "node not found on PATH" >&2; exit 1; fi
TMUX_BIN="$(command -v tmux || true)"
if [[ -z "$TMUX_BIN" ]]; then echo "tmux not found on PATH" >&2; exit 1; fi
JQ_BIN="$(command -v jq || true)"
if [[ -z "$JQ_BIN" ]]; then echo "jq not found on PATH" >&2; exit 1; fi

mkdir -p "$LOG_DIR"

# shellcheck source=service-helper.sh
source "$REPO_DIR/scripts/service-helper.sh"

SVC_PROGRAM=$'/bin/bash\n'"$SCRIPT"
SVC_LOG="$LOG_DIR/orchestrator-watchdog.log"
SVC_ENV="SUPERBOT2_HOME=$SUPERBOT2_HOME"
# Managers' dirs are absent from launchd's (and systemd's) minimal PATH — bake them in.
SVC_PATH="$(dirname "$NODE_BIN"):$(dirname "$TMUX_BIN"):$(dirname "$JQ_BIN"):/usr/bin:/bin:/usr/sbin:/sbin"
service_install orchestratorwatchdog keepalive

echo "orchestrator-watchdog installed and loaded."
echo "  Script: $SCRIPT"
echo "  Logs:   $LOG_DIR/orchestrator-watchdog.log"
