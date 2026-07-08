#!/bin/bash
# Install the orchestrator active-wake nudge as a macOS launchd agent.
#
# *** DO NOT RUN THIS CASUALLY. *** This loads a watcher that can send `tmux send-keys Enter`
# into the LIVE orchestrator pane. It is intentionally NOT run by the build that created it.
# Full runbook: ~/.superbot2/spaces/superbot2-app/knowledge/orchestrator-wake-mechanism.md
# Cut it over DELIBERATELY, and only after a dry-run shakedown:
#
#   # 1. Observe-only against the live system (NEVER sends keys):
#   SUPERBOT2_HOME="$HOME/.superbot2" node scripts/orchestrator-wake-nudge.mjs --dry-run
#   #    Watch the logs across an at-capacity window; confirm it only "would nudge" on a real
#   #    stall and NEVER while a turn streams or the prompt has pending text.
#
#   # 2. Only then install (live keystrokes enabled):
#   bash scripts/install-wake-nudge.sh
#
#   # To run it observe-only as the daemon (recommended first prod step), install with:
#   WAKE_NUDGE_DRY_RUN=1 bash scripts/install-wake-nudge.sh
#
#   # Uninstall / cut it back out instantly:
#   bash scripts/service-helper.sh uninstall wakenudge
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_DIR/scripts/orchestrator-wake-nudge.mjs"
SUPERBOT2_HOME="${SUPERBOT2_HOME:-$HOME/.superbot2}"
LOG_DIR="$SUPERBOT2_HOME/logs"
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then echo "node not found on PATH" >&2; exit 1; fi
# tmux is the whole mechanism — resolve it at install time and bake its dir into the
# service PATH. launchd's default PATH (/usr/bin:/bin:...) does NOT include homebrew,
# so without this every tmux call fails and the nudge fail-closes forever
# (observed live 2026-07-03: endless "no-nudge (prompt-not-empty)" from a null capture).
TMUX_BIN="$(command -v tmux || true)"
if [[ -z "$TMUX_BIN" ]]; then echo "tmux not found on PATH" >&2; exit 1; fi

# Optional: install in dry-run (observe-only) mode.
EXTRA_ARGS=""
if [[ "${WAKE_NUDGE_DRY_RUN:-}" == "1" ]]; then EXTRA_ARGS="--dry-run"; fi

mkdir -p "$LOG_DIR"

# shellcheck source=service-helper.sh
source "$REPO_DIR/scripts/service-helper.sh"

SVC_PROGRAM="$NODE_BIN"$'\n'"$SCRIPT"
[[ -n "$EXTRA_ARGS" ]] && SVC_PROGRAM="$SVC_PROGRAM"$'\n'"$EXTRA_ARGS"
SVC_LOG="$LOG_DIR/wake-nudge.log"
SVC_ENV=$'SUPERBOT2_HOME='"$SUPERBOT2_HOME"$'\nSUPERBOT2_NAME='"${SUPERBOT2_NAME:-}"
SVC_PATH="$(dirname "$NODE_BIN"):$(dirname "$TMUX_BIN"):/usr/bin:/bin:/usr/sbin:/sbin"
service_install wakenudge keepalive

echo "wake-nudge installed and loaded${EXTRA_ARGS:+ (DRY-RUN observe-only)}."
echo "  Script: $SCRIPT"
echo "  Logs:   $LOG_DIR/wake-nudge.log"
