#!/bin/bash
# Tests for orchestrator-watchdog.sh decision logic (crash relaunch, cap, grace, wedge).
# Sources the script with OW_TEST_SOURCE=1 (skips run_main) inside per-case subshells with
# an isolated SUPERBOT2_HOME and command shims via OW_*_CMD env overrides.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WATCHDOG="$SCRIPT_DIR/../scripts/orchestrator-watchdog.sh"
PASS=0
FAIL=0

ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

# Write a health-JSON fixture and point OW_HEALTH_CMD at it (echo would brace-expand the
# JSON's {a,b} commas). Call INSIDE snippets, after the script is sourced.
set_health() {
  printf %s "$1" > "$STATE_DIR/health.json"
  export OW_HEALTH_CMD="cat $STATE_DIR/health.json"
}

# Run a snippet in a subshell with a fresh temp home + the script sourced.
# $1 = snippet. Extra env can be prepended by the caller via VAR=... run_case '...'
run_case() {
  local snippet="$1"
  local tmp
  tmp="$(mktemp -d)"
  (
    export SUPERBOT2_HOME="$tmp"
    export OW_TEST_SOURCE=1
    export OW_SKIP_COMPANIONS=1
    export OW_SKIP_MIGRATE=1
    source "$WATCHDOG"
    eval "$snippet"
  )
  local rc=$?
  rm -rf "$tmp"
  return $rc
}

echo "orchestrator-watchdog.sh tests"

# 1. Dead orchestrator (past grace, under cap) => relaunch fired + recorded
run_case '
  export OW_RELAUNCH_CMD="touch \"$STATE_DIR/relaunched\""
  handle_dead_orchestrator
  [ -f "$STATE_DIR/relaunched" ] && [ "$(wc -l < "$RELAUNCHES_FILE" | tr -d " ")" = "1" ]
' && ok "dead orchestrator relaunches and records" || bad "dead orchestrator relaunches and records"

# 2. Startup grace: a just-recorded relaunch suppresses another relaunch
run_case '
  export OW_RELAUNCH_CMD="touch \"$STATE_DIR/relaunched2\""
  date +%s >> "$RELAUNCHES_FILE"
  handle_dead_orchestrator
  [ ! -f "$STATE_DIR/relaunched2" ]
' && ok "startup grace suppresses immediate re-relaunch" || bad "startup grace suppresses immediate re-relaunch"

# 3. Cap: RELAUNCH_CAP recent entries => no relaunch, cap alert recorded
run_case '
  export OW_RELAUNCH_CMD="touch \"$STATE_DIR/relaunched3\""
  export OW_STARTUP_GRACE_S=0; STARTUP_GRACE_S=0
  now=$(date +%s)
  for i in 1 2 3 4 5; do echo $((now - 100 - i)) >> "$RELAUNCHES_FILE"; done
  handle_dead_orchestrator
  [ ! -f "$STATE_DIR/relaunched3" ] && [ -f "$CAP_ALERT_FILE" ]
' && ok "relaunch cap blocks + alerts once" || bad "relaunch cap blocks + alerts once"

# 4. Window pruning: only-old entries are pruned => relaunch allowed again
run_case '
  export OW_RELAUNCH_CMD="touch \"$STATE_DIR/relaunched4\""
  export OW_STARTUP_GRACE_S=0; STARTUP_GRACE_S=0; CAP_WINDOW_S=60
  now=$(date +%s)
  for i in 1 2 3 4 5; do echo $((now - 500)) >> "$RELAUNCHES_FILE"; done
  handle_dead_orchestrator
  [ -f "$STATE_DIR/relaunched4" ]
' && ok "old relaunches pruned from cap window" || bad "old relaunches pruned from cap window"

# 5. Wedge (backlog stale, no turn, EMPTY prompt, launcher alive) => .restart touched
run_case '
  WEDGE_THRESHOLD_S=100
  set_health "{\"paneFound\":true,\"backlogAgeS\":500,\"transcriptAgeS\":600,\"transcriptBeforeBacklog\":true,\"promptEmpty\":true}"
  export OW_LAUNCHER_ALIVE_CMD="true"
  check_wedge
  [ -f "$RESTART_FLAG" ]
' && ok "wedge with empty prompt touches .restart" || bad "wedge with empty prompt touches .restart"

# 6. Pending user text => NEVER restart (prompt gate)
run_case '
  WEDGE_THRESHOLD_S=100
  set_health "{\"paneFound\":true,\"backlogAgeS\":500,\"transcriptAgeS\":600,\"transcriptBeforeBacklog\":true,\"promptEmpty\":false}"
  export OW_LAUNCHER_ALIVE_CMD="true"
  check_wedge
  [ ! -f "$RESTART_FLAG" ]
' && ok "pending user text blocks wedge restart" || bad "pending user text blocks wedge restart"

# 7. Transcript advanced past newest msg => processing, no wedge
run_case '
  WEDGE_THRESHOLD_S=100
  set_health "{\"paneFound\":true,\"backlogAgeS\":500,\"transcriptAgeS\":5,\"transcriptBeforeBacklog\":false,\"promptEmpty\":true}"
  export OW_LAUNCHER_ALIVE_CMD="true"
  check_wedge
  [ ! -f "$RESTART_FLAG" ]
' && ok "advanced transcript blocks wedge restart" || bad "advanced transcript blocks wedge restart"

# 8. Wedge cooldown: second wedge within cooldown does nothing
run_case '
  WEDGE_THRESHOLD_S=100; WEDGE_COOLDOWN_S=3600
  set_health "{\"paneFound\":true,\"backlogAgeS\":500,\"transcriptAgeS\":600,\"transcriptBeforeBacklog\":true,\"promptEmpty\":true}"
  export OW_LAUNCHER_ALIVE_CMD="true"
  check_wedge
  rm -f "$RESTART_FLAG"
  check_wedge
  [ ! -f "$RESTART_FLAG" ]
' && ok "wedge cooldown prevents repeat restarts" || bad "wedge cooldown prevents repeat restarts"

# 9. Wedge with DEAD launcher => orphan claude killed (not the flag path)
run_case '
  WEDGE_THRESHOLD_S=100
  set_health "{\"paneFound\":true,\"backlogAgeS\":500,\"transcriptAgeS\":600,\"transcriptBeforeBacklog\":true,\"promptEmpty\":true}"
  export OW_LAUNCHER_ALIVE_CMD="false"
  export OW_KILL_ORPHAN_CMD="touch \"$STATE_DIR/orphan-killed\""
  check_wedge
  [ ! -f "$RESTART_FLAG" ] && [ -f "$STATE_DIR/orphan-killed" ]
' && ok "dead launcher wedge kills orphan claude" || bad "dead launcher wedge kills orphan claude"

# 10. Healthy (no backlog) => no action
run_case '
  WEDGE_THRESHOLD_S=100
  set_health "{\"paneFound\":true,\"backlogAgeS\":null,\"transcriptAgeS\":5,\"transcriptBeforeBacklog\":false,\"promptEmpty\":true}"
  check_wedge
  [ ! -f "$RESTART_FLAG" ]
' && ok "no backlog => no wedge action" || bad "no backlog => no wedge action"

# 11. Boot dialog detected => auto-confirm (Enter) and no wedge action
run_case '
  WEDGE_THRESHOLD_S=100
  set_health "{\"paneFound\":true,\"paneId\":\"%9\",\"backlogAgeS\":500,\"transcriptAgeS\":600,\"transcriptBeforeBacklog\":true,\"promptEmpty\":false,\"bootDialog\":true}"
  export OW_ACCEPT_CMD="touch \"$STATE_DIR/dialog-accepted\""
  export OW_LAUNCHER_ALIVE_CMD="true"
  check_wedge
  [ -f "$STATE_DIR/dialog-accepted" ] && [ ! -f "$RESTART_FLAG" ]
' && ok "boot dialog auto-confirmed, no wedge" || bad "boot dialog auto-confirmed, no wedge"

# 12. DOWN confirmation: a single probe miss must NOT relaunch (false-DOWN guard)
run_case '
  export OW_ALIVE_CMD="false"
  export OW_RELAUNCH_CMD="touch \"$STATE_DIR/relaunched12\""
  supervise_cycle
  [ ! -f "$STATE_DIR/relaunched12" ]
' && ok "single probe miss does not relaunch" || bad "single probe miss does not relaunch"

# 13. DOWN confirmation: two consecutive misses => relaunch
run_case '
  export OW_ALIVE_CMD="false"
  export OW_RELAUNCH_CMD="touch \"$STATE_DIR/relaunched13\""
  supervise_cycle
  supervise_cycle
  [ -f "$STATE_DIR/relaunched13" ]
' && ok "two consecutive misses relaunch" || bad "two consecutive misses relaunch"

# 14. DOWN streak resets on an alive cycle: miss, alive, miss => no relaunch
run_case '
  export OW_ALIVE_CMD="[ -f \"$STATE_DIR/alive\" ]"
  export OW_RELAUNCH_CMD="touch \"$STATE_DIR/relaunched14\""
  set_health "{\"paneFound\":true,\"backlogAgeS\":null,\"transcriptAgeS\":5,\"transcriptBeforeBacklog\":false,\"promptEmpty\":true}"
  supervise_cycle                 # miss (streak 1)
  touch "$STATE_DIR/alive"
  supervise_cycle                 # alive (streak resets)
  rm -f "$STATE_DIR/alive"
  supervise_cycle                 # miss (streak 1 again)
  [ ! -f "$STATE_DIR/relaunched14" ]
' && ok "alive cycle resets the DOWN streak" || bad "alive cycle resets the DOWN streak"

# 15. Layered probe: pattern pgrep misses but a claude-named CHILD of the live launcher
# exists => ALIVE. Fake launcher = a background subshell; fake claude = sleep exec'd
# with argv[0]="claude" (comm — what the probe matches — is argv[0] on macOS; a copied
# sleep BINARY named claude gets SIGKILL'd by AMFI, so exec -a is the only clean fake).
run_case '
  export OW_ALIVE_RETRIES=1; ALIVE_RETRIES=1
  mkdir -p "$STATE_DIR/bin"
  printf "#!/bin/bash\nexit 1\n" > "$STATE_DIR/bin/pgrep"; chmod +x "$STATE_DIR/bin/pgrep"
  export PATH="$STATE_DIR/bin:$PATH"
  ( bash -c "exec -a claude sleep 30" & echo $! > "$STATE_DIR/fake-claude.pid"; sleep 30 ) &
  FAKE_LAUNCHER=$!
  echo "$FAKE_LAUNCHER" > "$LAUNCHER_PID_FILE"
  sleep 1
  orchestrator_alive; rc=$?
  kill "$FAKE_LAUNCHER" "$(cat "$STATE_DIR/fake-claude.pid" 2>/dev/null)" 2>/dev/null
  [ $rc -eq 0 ]
' && ok "claude-named launcher child counts as alive despite pgrep miss" || bad "claude-named launcher child counts as alive despite pgrep miss"

# 16. Layered probe negative: launcher alive but NO claude child + pgrep miss => DOWN
run_case '
  export OW_ALIVE_RETRIES=1; ALIVE_RETRIES=1
  mkdir -p "$STATE_DIR/bin"
  printf "#!/bin/bash\nexit 1\n" > "$STATE_DIR/bin/pgrep"; chmod +x "$STATE_DIR/bin/pgrep"
  export PATH="$STATE_DIR/bin:$PATH"
  sleep 30 &
  FAKE_LAUNCHER=$!
  echo "$FAKE_LAUNCHER" > "$LAUNCHER_PID_FILE"
  orchestrator_alive; rc=$?
  kill "$FAKE_LAUNCHER" 2>/dev/null
  [ $rc -ne 0 ]
' && ok "no claude child + pgrep miss => down" || bad "no claude child + pgrep miss => down"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
