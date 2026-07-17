#!/bin/bash
# Tests for scheduler.sh durability: missed-job catch-up, coalescing, non-blocking
# script dispatch, and the max-runtime self-guard.
#
# Incident (2026-07-02 08:00–16:30): one scheduler tick dispatched a script job whose
# child stayed in the launchd process group; launchd (AbandonProcessGroup=false) treated
# the job as still running and suppressed every 60s StartInterval fire until the hung
# child died ~8h later. Every job due in that window was silently skipped with NO
# back-fill (the old code fired a slot only when jobH==now && jobM==now).
#
# Fixes under test:
#   1. Catch-up — on each tick, any TODAY slot that is due-now-or-overdue and not yet
#      marked fires (instead of being lost to the exact-minute match).
#   2. Coalesce — a job that missed many fires (e.g. a 30-min sweep down 8h) fires ONCE
#      on recovery (latest overdue slot), with every missed slot marked so it can't
#      re-fire the backlog.
#   3. Non-blocking dispatch — a slow script job never blocks the tick (setsid detach).
#   4. Self-guard — a wedged synchronous op can't dark the scheduler forever; the tick
#      self-terminates under SCHEDULER_MAX_TICK_SECS so the next fire recovers.
#
# Each case runs the REAL scheduler against an isolated SUPERBOT2_HOME. Job times are
# computed relative to the wall clock, so catch-up cases are scoped to "today"; the
# harness skips them in the rare minutes right after midnight (documented bound).
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCHEDULER="$SCRIPT_DIR/../scripts/scheduler.sh"
PATH_ORIG="$PATH"
PASS=0
FAIL=0

ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

NOW_MINUTES=$(( 10#$(date +%H) * 60 + 10#$(date +%M) ))

# HH:MM offset minutes from now (BSD date). e.g. t_offset -5  → 5 min ago.
t_offset() { date -v"${1}M" '+%H:%M'; }

make_home() {
  TMP="$(mktemp -d)"
  HOMEDIR="$TMP/home"
  TEAM="$HOMEDIR/.claude/teams/session-test"
  mkdir -p "$TEAM/inboxes" "$HOMEDIR/logs" "$HOMEDIR/spaces" "$HOMEDIR/scripts" "$TMP/.local/bin"
  echo '{"name":"session-test"}' > "$TEAM/config.json"
  echo '[]' > "$TEAM/inboxes/team-lead.json"
  INBOX="$TEAM/inboxes/team-lead.json"
  LASTRUN="$HOMEDIR/schedule-last-run.json"
  SCHEDLOG="$HOMEDIR/logs/scheduler.log"
}

# Write the global config.json schedule from a JSON array passed on stdin.
write_schedule() { jq -n --argjson s "$(cat)" '{schedule: $s}' > "$HOMEDIR/config.json"; }

# Run the real scheduler pinned to the session-test team. HOME=$TMP isolates the pid
# file and lets a PATH shim (self-guard case) win. SUPERBOT2_NAME!=superbot2 force-pins.
run_sched() {
  HOME="$TMP" PATH="$PATH_ORIG" SUPERBOT2_HOME="$HOMEDIR" SUPERBOT2_NAME="session-test" \
    "$@" bash "$SCHEDULER" >> "$TMP/out.log" 2>&1
}

job_msg_count() { jq --arg n "$1" '[.[] | select(.metadata.jobName == $n)] | length' "$INBOX" 2>/dev/null || echo 0; }
lastrun_has()   { jq -e --arg k "$1" 'has($k)' "$LASTRUN" >/dev/null 2>&1; }
cleanup()       { rm -rf "$TMP"; }

MIDNIGHT_SKIP=0
if (( NOW_MINUTES < 95 )); then MIDNIGHT_SKIP=1; fi  # need ~90 min of past room

# ── Test 1: a missed task job is caught up and fired exactly once ──────────────────
echo "Test 1: catch-up fires a missed (overdue, unfired) task job once"
if (( MIDNIGHT_SKIP )); then
  echo "  ⏭  skipped (too close to midnight — no past room today)"
else
  make_home
  T5="$(t_offset -5)"
  write_schedule <<EOF
[{"name":"missed-daily","time":"$T5","task":"do the thing"}]
EOF
  run_sched
  [[ "$(job_msg_count missed-daily)" == "1" ]] && ok "fired exactly once" || bad "expected 1 message, got $(job_msg_count missed-daily)"
  lastrun_has "missed-daily:$(date +%Y-%m-%d)T$T5" && ok "slot marked in last-run" || bad "slot not marked in last-run"
  grep -q "catch-up" "$SCHEDLOG" && ok "logged as catch-up" || bad "not logged as catch-up"
  cleanup
fi

# ── Test 2: a job that missed MANY slots fires once, all slots coalesced ───────────
echo "Test 2: coalesce — a sweep down for hours fires once, every missed slot marked"
if (( MIDNIGHT_SKIP )); then
  echo "  ⏭  skipped (too close to midnight)"
else
  make_home
  A="$(t_offset -90)"; B="$(t_offset -60)"; C="$(t_offset -30)"; D="$(t_offset -6)"
  write_schedule <<EOF
[{"name":"missed-sweep","times":["$A","$B","$C","$D"],"task":"sweep"}]
EOF
  run_sched
  DATE="$(date +%Y-%m-%d)"
  [[ "$(job_msg_count missed-sweep)" == "1" ]] && ok "dispatched exactly once (coalesced)" || bad "expected 1, got $(job_msg_count missed-sweep)"
  # The single dispatched slot must be the LATEST overdue one (D).
  DISPATCHED_TIME=$(jq -r --arg n missed-sweep 'first(.[] | select(.metadata.jobName==$n) | .metadata.scheduledTime)' "$INBOX")
  [[ "$DISPATCHED_TIME" == "$D" ]] && ok "dispatched the most-recent slot ($D)" || bad "dispatched $DISPATCHED_TIME, expected $D"
  ALLMARK=1
  for t in "$A" "$B" "$C" "$D"; do lastrun_has "missed-sweep:${DATE}T$t" || ALLMARK=0; done
  [[ "$ALLMARK" == "1" ]] && ok "all 4 missed slots marked (no backlog re-fire)" || bad "not all missed slots marked"
  cleanup
fi

# ── Test 3: a future slot today is NOT fired ──────────────────────────────────────
echo "Test 3: a slot still in the future today does not fire"
make_home
FUT="$(t_offset 45)"
write_schedule <<EOF
[{"name":"future-job","time":"$FUT","task":"later"}]
EOF
run_sched
[[ "$(job_msg_count future-job)" == "0" ]] && ok "future slot not fired" || bad "future slot fired ($(job_msg_count future-job) msgs)"
lastrun_has "future-job:$(date +%Y-%m-%d)T$FUT" && bad "future slot wrongly marked" || ok "future slot not marked"
cleanup

# ── Test 4: dedup — a caught-up job does not re-fire on the next tick ──────────────
echo "Test 4: dedup — running twice does not re-fire an already-caught-up job"
if (( MIDNIGHT_SKIP )); then
  echo "  ⏭  skipped (too close to midnight)"
else
  make_home
  T3="$(t_offset -3)"
  write_schedule <<EOF
[{"name":"dedup-job","time":"$T3","task":"once only"}]
EOF
  run_sched
  run_sched
  [[ "$(job_msg_count dedup-job)" == "1" ]] && ok "fired once across two ticks" || bad "expected 1, got $(job_msg_count dedup-job)"
  cleanup
fi

# ── Test 5: non-blocking dispatch — a slow script job never blocks the tick ────────
echo "Test 5: a slow script job is detached and does not block the tick"
if (( MIDNIGHT_SKIP )); then
  echo "  ⏭  skipped (too close to midnight)"
else
  make_home
  cat > "$HOMEDIR/scripts/slow.sh" <<'EOF'
#!/bin/bash
touch "$SUPERBOT2_HOME/slow-ran.sentinel"
sleep 5
EOF
  chmod +x "$HOMEDIR/scripts/slow.sh"
  T1="$(t_offset -1)"
  write_schedule <<EOF
[{"name":"slow-script","time":"$T1","task":"","script":"scripts/slow.sh"}]
EOF
  START=$SECONDS
  run_sched
  ELAPSED=$((SECONDS - START))
  (( ELAPSED < 10 )) && ok "tick returned fast (${ELAPSED}s, not blocked on the 5s script)" || bad "tick blocked ${ELAPSED}s"
  grep -q "Executing script for slow-script" "$SCHEDLOG" && ok "script was dispatched" || bad "script not dispatched"
  [[ -f "$HOMEDIR/slow-ran.sentinel" ]] && ok "detached script actually launched" || bad "detached script did not launch"
  cleanup
fi

# ── Test 6: self-guard — a wedged synchronous op can't dark the scheduler forever ──
echo "Test 6: self-guard kills a wedged tick within the max-runtime bound"
make_home
# Shim node to hang. scheduler.sh prepends \$HOME/.local/bin to PATH, so this wins and
# the FIRST node call (team resolution) blocks — simulating any wedged synchronous op.
cat > "$TMP/.local/bin/node" <<'EOF'
#!/bin/bash
sleep 300
EOF
chmod +x "$TMP/.local/bin/node"
echo '{"schedule":[]}' > "$HOMEDIR/config.json"
START=$SECONDS
HOME="$TMP" PATH="$PATH_ORIG" SUPERBOT2_HOME="$HOMEDIR" SUPERBOT2_NAME="session-test" \
  SCHEDULER_MAX_TICK_SECS=2 bash "$SCHEDULER" >> "$TMP/out.log" 2>&1
ELAPSED=$((SECONDS - START))
(( ELAPSED < 10 )) && ok "wedged tick self-terminated (${ELAPSED}s, guard=2s)" || bad "wedged tick ran ${ELAPSED}s (guard failed)"
grep -q "SELF-GUARD" "$SCHEDLOG" && ok "self-guard logged the kill" || bad "no SELF-GUARD log line"
pkill -f "$TMP/.local/bin/node" 2>/dev/null
cleanup

echo
echo "── scheduler-catchup: $PASS passed, $FAIL failed ──"
[[ "$FAIL" -eq 0 ]]
