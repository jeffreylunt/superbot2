#!/bin/bash
# Install the telegram supervision chain as a macOS launchd agent. Jeff's ask
# (2026-07-03): if superbot2 goes down for ANY reason it must come back fully
# reachable via Telegram — and run in tmux so App Nap can't throttle it.
#
#   Install / reload:  bash scripts/install-telegram-watchdog.sh
#   Uninstall:         bash scripts/service-helper.sh uninstall telegramwatchdog
#   Watch live:        tmux attach -t sb2-telegram
#
# Chain: launchd (KeepAlive) -> telegram-tmux-supervisor.sh -> tmux session
#        -> telegram-watchdog.sh -> telegram-watcher.mjs
#
# launchd's default PATH has neither node nor tmux — resolve at install time and
# bake the dirs into the plist PATH (same class of bug that dark-launched the
# wake-nudge; see install-orchestrator-watchdog.sh).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_DIR/scripts/telegram-tmux-supervisor.sh"
SUPERBOT2_HOME="${SUPERBOT2_HOME:-$HOME/.superbot2}"
LOG_DIR="$SUPERBOT2_HOME/logs"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then echo "node not found on PATH" >&2; exit 1; fi
TMUX_BIN="$(command -v tmux || true)"
if [[ -z "$TMUX_BIN" ]]; then echo "tmux not found on PATH" >&2; exit 1; fi

mkdir -p "$LOG_DIR"

# shellcheck source=service-helper.sh
source "$REPO_DIR/scripts/service-helper.sh"

SVC_PROGRAM=$'/bin/bash\n'"$SCRIPT"
SVC_LOG="$LOG_DIR/telegram-tmux-supervisor.log"
SVC_ENV="SUPERBOT2_HOME=$SUPERBOT2_HOME"
SVC_PATH="$(dirname "$NODE_BIN"):$(dirname "$TMUX_BIN"):/usr/bin:/bin:/usr/sbin:/sbin"
# macOS-only hint that keeps App Nap from throttling the interactive tmux chain;
# ignored on Linux.
SVC_PROCESS_TYPE="Interactive"
service_install telegramwatchdog keepalive

echo "telegram-watchdog agent installed and loaded."
echo "  Supervisor: $SCRIPT"
echo "  Logs:       $LOG_DIR/telegram-tmux-supervisor.log (+ telegram-watcher.log)"
echo "  Watch live: tmux attach -t sb2-telegram"
