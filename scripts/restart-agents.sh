#!/bin/bash
# restart-agents.sh — reload every superbot2 launchd agent so it runs CURRENT code.
#
# Why: the long-lived daemons (wake-nudge, telegram/orchestrator watchdogs) cache the
# code they were started with. After a code change (git pull / `superbot2 update`) they
# keep running STALE code until restarted — which bit us repeatedly: e.g. on 2026-07-15
# the wake-nudge daemon was running 11-day-old code and mis-read the orchestrator prompt,
# blocking all nudges while Telegram messages piled up. `superbot2 update` calls this at
# the end so a deploy actually takes effect; you can also run it by hand anytime.
#
#   bash scripts/restart-agents.sh            # kickstart all installed superbot2 agents
#   bash scripts/restart-agents.sh --dry-run  # list what WOULD be restarted, change nothing
#
# kickstart -k restarts KeepAlive daemons (wake-nudge, watchdogs) with fresh code, and
# harmlessly runs cron-style agents (heartbeat, scheduler) once. Restarting the telegram/
# orchestrator watchdogs briefly cycles their supervised child (watcher / orchestrator
# relaunch) — expected during an explicit deploy; the chain self-heals within seconds.
set -uo pipefail

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

UID_NUM="$(id -u)"
LA_DIR="$HOME/Library/LaunchAgents"

# Enumerate installed agents dynamically so this stays correct as agents are added/removed.
# Portable to macOS's stock bash 3.2 (no mapfile): build the array with a glob loop, and
# skip the literal pattern when nothing matches.
PLISTS=()
for p in "$LA_DIR"/com.superbot2.*.plist; do
  [[ -e "$p" ]] || continue
  PLISTS+=("$p")
done
if [[ ${#PLISTS[@]} -eq 0 ]]; then
  echo "No com.superbot2.* launchd agents installed — nothing to restart."
  exit 0
fi

$DRY_RUN && echo "[dry-run] would reload these superbot2 agents (running current code):" \
         || echo "Reloading superbot2 launchd agents (so they run current code)..."

rc=0
for plist in "${PLISTS[@]}"; do
  label="$(basename "$plist" .plist)"
  target="gui/$UID_NUM/$label"
  if ! launchctl print "$target" &>/dev/null; then
    echo "  - $label (not loaded — skipped)"
    continue
  fi
  if $DRY_RUN; then
    echo "  • $label"
    continue
  fi
  if launchctl kickstart -k "$target" 2>/dev/null; then
    echo "  ✓ $label restarted"
  else
    echo "  ✗ $label kickstart failed"
    rc=1
  fi
done

# The telegram WATCHER is a grandchild of the telegramwatchdog agent (agent -> tmux
# supervisor -> watchdog -> watcher). The supervisor's singleton guard leaves a healthy
# watchdog+watcher running, so kickstarting the agent alone does NOT reload watcher code.
# Cycle the watcher explicitly: SIGTERM it (graceful outbound flush) and let the watchdog
# respawn it with the current code. Skipped in --dry-run.
SUPERBOT_DIR="${SUPERBOT2_HOME:-$HOME/.superbot2}"
WATCHER_PID_FILE="$SUPERBOT_DIR/telegram.pid"
if $DRY_RUN; then
  echo "  • telegram-watcher (would SIGTERM so the watchdog respawns it with current code)"
elif [[ -f "$WATCHER_PID_FILE" ]]; then
  wpid="$(cat "$WATCHER_PID_FILE" 2>/dev/null || true)"
  if [[ -n "$wpid" ]] && kill -0 "$wpid" 2>/dev/null; then
    kill "$wpid" 2>/dev/null && echo "  ✓ telegram-watcher (pid $wpid) cycled — watchdog will respawn with current code" \
                             || echo "  ✗ telegram-watcher (pid $wpid) could not be signaled"
  fi
fi

$DRY_RUN || echo "Agent reload complete."
exit $rc
