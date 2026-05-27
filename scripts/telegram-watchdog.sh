#!/bin/bash
# telegram-watchdog.sh — Supervises telegram-watcher.mjs with auto-restart
# Usage: bash telegram-watchdog.sh
#
# Keeps the watcher running as long as telegram is ENABLED in config.json:
#   - Restarts on ANY exit (crash, SIGTERM/kill, etc.) with exponential backoff
#     (1s -> 2s -> ... -> 60s). Backoff resets after 60s of stable running.
#   - Only stops supervising when telegram is disabled/removed from config.json.
# Liveness monitoring (kills the watcher so it gets restarted):
#   - INBOUND heartbeat (telegram-heartbeat.txt, written by the getUpdates loop)
#     stale > HEARTBEAT_STALE_THRESHOLD  => watcher hung.
#   - OUTBOUND heartbeat (telegram-outbound-heartbeat.txt, written by the reply
#     relay loop) stale > OUTBOUND_STALE_THRESHOLD => outbound relay silently
#     stalled (the 2026-05-27 incident). This self-heals what was previously a
#     silent ~1h outage. See knowledge/telegram-outbound-stall.md.
# Writes its own PID to ~/.superbot2/telegram-watchdog.pid for management.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WATCHER_SCRIPT="${TELEGRAM_WATCHER_SCRIPT:-$SCRIPT_DIR/telegram-watcher.mjs}"
SUPERBOT_DIR="${SUPERBOT2_HOME:-$HOME/.superbot2}"
CONFIG_FILE="$SUPERBOT_DIR/config.json"
WATCHDOG_PID_FILE="$SUPERBOT_DIR/telegram-watchdog.pid"
HEARTBEAT_FILE="$SUPERBOT_DIR/telegram-heartbeat.txt"
OUTBOUND_HEARTBEAT_FILE="$SUPERBOT_DIR/telegram-outbound-heartbeat.txt"
LOG_DIR="$SUPERBOT_DIR/logs"
LOG_FILE="$LOG_DIR/telegram-watcher.log"
HEALTH_CHECK_INTERVAL="${TELEGRAM_HEALTH_CHECK_INTERVAL:-15}"        # poll child + heartbeats every 15s (fast crash/stall recovery)
HEARTBEAT_STALE_THRESHOLD="${TELEGRAM_HEARTBEAT_STALE_THRESHOLD:-300}" # inbound stale = 5 min
OUTBOUND_STALE_THRESHOLD="${TELEGRAM_OUTBOUND_STALE_THRESHOLD:-180}"   # outbound stale = 3 min
MAX_BACKOFF="${TELEGRAM_MAX_BACKOFF:-60}"
STABLE_THRESHOLD="${TELEGRAM_STABLE_THRESHOLD:-60}"  # seconds of uptime before resetting backoff

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] telegram-watchdog: $1" >> "$LOG_FILE"
}

# Returns 0 (true) if telegram is enabled in config.json. Conservative: if the
# config can't be read/parsed, assume ENABLED so we never accidentally stop
# supervising due to a transient read error.
telegram_enabled() {
  [ -f "$CONFIG_FILE" ] || return 0
  node -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.exit(c && c.telegram && c.telegram.enabled === false ? 1 : 0);
    } catch { process.exit(0); }
  ' "$CONFIG_FILE" 2>/dev/null
}

# Returns age in seconds of a heartbeat file (epoch-ms contents), or empty if absent/unreadable.
heartbeat_age_s() {
  local file="$1"
  [ -f "$file" ] || return 1
  local ts
  ts=$(cat "$file" 2>/dev/null)
  [ -n "$ts" ] || return 1
  local now_ms=$(($(date +%s) * 1000))
  echo $(((now_ms - ts) / 1000))
}

# Singleton guard: refuse to start if another watchdog is already running.
# Two watchdogs would each try to (re)launch the watcher and fight over the
# watcher PID file, causing restart churn. Mirrors the watcher's own check.
if [ -f "$WATCHDOG_PID_FILE" ]; then
  EXISTING_PID="$(cat "$WATCHDOG_PID_FILE" 2>/dev/null)"
  if [ -n "$EXISTING_PID" ] && [ "$EXISTING_PID" != "$$" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    log "another watchdog already running (pid=$EXISTING_PID) — exiting"
    exit 0
  fi
fi

# Write watchdog PID
echo $$ > "$WATCHDOG_PID_FILE"

cleanup() {
  log "shutting down"
  # Kill the watcher child if running
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill "$CHILD_PID" 2>/dev/null
    wait "$CHILD_PID" 2>/dev/null
  fi
  rm -f "$WATCHDOG_PID_FILE"
  exit 0
}

trap cleanup SIGTERM SIGINT SIGHUP

BACKOFF=1

log "starting (pid=$$)"

while true; do
  # Stop supervising only if telegram has been disabled.
  if ! telegram_enabled; then
    log "telegram disabled in config — not starting watcher, exiting"
    rm -f "$WATCHDOG_PID_FILE"
    exit 0
  fi

  START_TIME=$(date +%s)

  log "launching watcher (backoff=${BACKOFF}s)"

  node "$WATCHER_SCRIPT" >> "$LOG_FILE" 2>&1 &
  CHILD_PID=$!

  # Monitor loop: check child status and both heartbeats
  while true; do
    # Check if child is still running
    if ! kill -0 "$CHILD_PID" 2>/dev/null; then
      wait "$CHILD_PID" 2>/dev/null
      EXIT_CODE=$?
      CHILD_PID=""
      break
    fi

    # Check INBOUND heartbeat staleness (watcher hung entirely)
    INBOUND_AGE=$(heartbeat_age_s "$HEARTBEAT_FILE")
    if [ -n "$INBOUND_AGE" ] && [ "$INBOUND_AGE" -gt "$HEARTBEAT_STALE_THRESHOLD" ]; then
      log "INBOUND heartbeat stale (${INBOUND_AGE}s > ${HEARTBEAT_STALE_THRESHOLD}s) — killing watcher to restart"
      kill "$CHILD_PID" 2>/dev/null
      wait "$CHILD_PID" 2>/dev/null
      EXIT_CODE=1
      CHILD_PID=""
      rm -f "$HEARTBEAT_FILE"
      break
    fi

    # Check OUTBOUND heartbeat staleness (outbound relay silently stalled while
    # inbound kept working — the 2026-05-27 failure mode). Loud log + restart.
    OUTBOUND_AGE=$(heartbeat_age_s "$OUTBOUND_HEARTBEAT_FILE")
    if [ -n "$OUTBOUND_AGE" ] && [ "$OUTBOUND_AGE" -gt "$OUTBOUND_STALE_THRESHOLD" ]; then
      log "!!! OUTBOUND relay STALLED: heartbeat stale (${OUTBOUND_AGE}s > ${OUTBOUND_STALE_THRESHOLD}s) while process alive — killing watcher to self-heal"
      kill "$CHILD_PID" 2>/dev/null
      wait "$CHILD_PID" 2>/dev/null
      EXIT_CODE=1
      CHILD_PID=""
      rm -f "$OUTBOUND_HEARTBEAT_FILE"
      break
    fi

    sleep "$HEALTH_CHECK_INTERVAL"
  done

  END_TIME=$(date +%s)
  UPTIME=$((END_TIME - START_TIME))

  log "watcher exited (code=$EXIT_CODE, uptime=${UPTIME}s)"

  # If the watcher ran for a while, it was stable — reset backoff
  if [ "$UPTIME" -ge "$STABLE_THRESHOLD" ]; then
    BACKOFF=1
  fi

  # Restart-while-enabled: keep the watcher alive regardless of exit code as long
  # as telegram is still enabled. (Previously exit code 0 — which a SIGTERM'd
  # watcher returns — was treated as "clean, don't restart", so killing the
  # watcher silently stopped supervision. Confirmed in the 2026-05-27 log.)
  if ! telegram_enabled; then
    log "telegram disabled in config — not restarting, exiting"
    rm -f "$WATCHDOG_PID_FILE"
    exit 0
  fi

  log "restarting in ${BACKOFF}s..."
  sleep "$BACKOFF"

  # Exponential backoff
  BACKOFF=$((BACKOFF * 2))
  if [ "$BACKOFF" -gt "$MAX_BACKOFF" ]; then
    BACKOFF=$MAX_BACKOFF
  fi
done
