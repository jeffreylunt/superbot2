#!/bin/bash
# telegram-tmux-supervisor.sh — launchd-run loop that guarantees the telegram
# watchdog (and therefore the watcher) is ALWAYS running, inside a tmux session.
#
# Why this exists (Jeff, 2026-07-03): the telegram watchdog was hand-started, so
# a reboot / crash of the watchdog itself silently killed Telegram reachability
# forever — the one channel that must survive everything. And per Jeff, the chain
# should live in a tmux pane so macOS App Nap / background throttling can't make
# it stop responding.
#
# Supervision chain (each layer restarts the one below):
#   launchd (KeepAlive)  ->  this supervisor  ->  tmux session "sb2-telegram"
#     ->  telegram-watchdog.sh  ->  telegram-watcher.mjs
#
# The watchdog's own singleton guard (telegram-watchdog.pid + kill -0) makes this
# loop idempotent: if a watchdog is already running ANYWHERE (tmux or not), we
# leave it alone rather than churn it. We only (re)create the tmux session when
# no live watchdog exists.
#
#   Attach to watch live:  tmux attach -t sb2-telegram
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WATCHDOG_SCRIPT="$SCRIPT_DIR/telegram-watchdog.sh"
SUPERBOT_DIR="${SUPERBOT2_HOME:-$HOME/.superbot2}"
WATCHDOG_PID_FILE="$SUPERBOT_DIR/telegram-watchdog.pid"
LOG_FILE="$SUPERBOT_DIR/logs/telegram-tmux-supervisor.log"
TMUX_SESSION="${TELEGRAM_TMUX_SESSION:-sb2-telegram}"
CHECK_INTERVAL="${TELEGRAM_SUPERVISOR_INTERVAL:-20}"

mkdir -p "$SUPERBOT_DIR/logs"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] telegram-tmux-supervisor: $1" >> "$LOG_FILE"
}

watchdog_alive() {
  [ -f "$WATCHDOG_PID_FILE" ] || return 1
  local pid
  pid="$(cat "$WATCHDOG_PID_FILE" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

ensure_session() {
  # A session whose watchdog died is stale — kill it so the fresh one is clean.
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "tmux session '$TMUX_SESSION' exists but watchdog is dead — recreating"
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  fi
  log "starting watchdog in tmux session '$TMUX_SESSION'"
  tmux new-session -d -s "$TMUX_SESSION" \
    "exec /bin/bash '$WATCHDOG_SCRIPT'" 2>>"$LOG_FILE" || {
    log "tmux new-session FAILED (exit $?) — will retry in ${CHECK_INTERVAL}s"
    return 1
  }
}

log "starting (pid=$$, session=$TMUX_SESSION, interval=${CHECK_INTERVAL}s)"

while true; do
  if ! watchdog_alive; then
    ensure_session
  fi
  sleep "$CHECK_INTERVAL"
done
