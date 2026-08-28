#!/bin/bash
# Tests for telegram-watchdog.sh — the three reliability behaviors hardened after
# the 2026-05-27 silent outbound-stall incident:
#   A. Restart-while-enabled: a watcher that exits cleanly (code 0, e.g. SIGTERM)
#      is RESTARTED as long as telegram is enabled (regression: exit-0 used to stop
#      supervision entirely).
#   B. Outbound stall self-heal: inbound heartbeat fresh but outbound heartbeat
#      stale => watchdog logs loudly and restarts the watcher.
#   C. Disabled => stop: telegram.enabled=false => watchdog exits without launching.
#
# Uses a temp SUPERBOT2_HOME, a fake watcher script, and short thresholds via env.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WATCHDOG="$SCRIPT_DIR/../scripts/telegram-watchdog.sh"
PASS=0
FAIL=0

ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

make_env() {
  TMP="$(mktemp -d)"
  mkdir -p "$TMP/logs"
  COUNTER="$TMP/launch-count.txt"
  echo 0 > "$COUNTER"
  # Fake watcher: increments launch counter, writes inbound heartbeat every 0.5s,
  # writes outbound heartbeat unless $TMP/stall-outbound exists, and exits 0 if
  # $TMP/die exists (consuming the flag so the NEXT launch runs normally).
  cat > "$TMP/fake-watcher.mjs" <<EOF
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
const H = '$TMP'
const n = Number(readFileSync(H + '/launch-count.txt', 'utf8')) + 1
writeFileSync(H + '/launch-count.txt', String(n))
function loop() {
  writeFileSync(H + '/telegram-heartbeat.txt', String(Date.now()))
  if (!existsSync(H + '/stall-outbound')) {
    writeFileSync(H + '/telegram-outbound-heartbeat.txt', String(Date.now()))
  }
  if (existsSync(H + '/die')) { try { unlinkSync(H + '/die') } catch {} ; process.exit(0) }
  setTimeout(loop, 500)
}
loop()
EOF
}

start_watchdog() {
  SUPERBOT2_HOME="$TMP" \
  TELEGRAM_WATCHER_SCRIPT="$TMP/fake-watcher.mjs" \
  TELEGRAM_HEALTH_CHECK_INTERVAL=1 \
  TELEGRAM_HEARTBEAT_STALE_THRESHOLD=5 \
  TELEGRAM_OUTBOUND_STALE_THRESHOLD=3 \
  TELEGRAM_STABLE_THRESHOLD=2 \
  TELEGRAM_MAX_BACKOFF=1 \
    bash "$WATCHDOG" &
  WD_PID=$!
}

stop_watchdog() {
  kill "$WD_PID" 2>/dev/null
  wait "$WD_PID" 2>/dev/null
  pkill -f "$TMP/fake-watcher.mjs" 2>/dev/null
}

count() { cat "$COUNTER" 2>/dev/null; }

# ── De-flaking Tests A and B (2026-08-27) ───────────────────────────────────────
# Both tests assert on a watcher RESTART, and both used a FIXED sleep sized to the
# happy path. Test B slept 7s. The real end-to-end restart latency, measured over 6
# runs on an idle machine, is 6.42s–7.47s — so 2 of 6 runs overran the window and the
# suite reported a spurious "NOT restarted on outbound stall (count=1)" while the
# companion "logged outbound stall loudly" assertion (which fires ~2.1s earlier)
# passed. That is exactly the failure seen on 2026-08-27.
#
# Root cause of the ~1s spread that straddles the boundary: heartbeat_age_s computes
#   (date +%s * 1000 - <epoch-ms heartbeat>) / 1000
# which truncates "now" to the whole second while the heartbeat carries milliseconds.
# So a stall crosses the strict `-gt 3` test anywhere from 4.0s to 5.0s after the last
# outbound write, depending only on where in the wall-clock second the stall began.
# The rest of the latency is fixed and unavoidable: up to 1s of poll interval, up to 1s
# in kill_watcher's 1-second-granularity wait loop, the 1s restart backoff, plus node
# startup — about 2.1s. Worst case ~7.5s against a 7s window.
#
# Fix: wait for the CONDITION with a generous ceiling instead of sleeping a fixed
# amount. That removes the timing sensitivity rather than moving the boundary, and it
# also makes the tests finish sooner in the common case.
wait_for() {
  local timeout="$1"; shift
  local deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    "$@" && return 0
    sleep 0.2
  done
  return 1
}
count_at_least() { [ "$(count)" -ge "$1" ]; }
count_above()    { [ "$(count)" -gt "$1" ]; }
log_has()        { grep -q "$1" "$TMP/logs/telegram-watcher.log" 2>/dev/null; }

# --- Test A: restart-while-enabled (clean exit 0 still restarts) ---
echo "Test A: watcher exit 0 is restarted while telegram enabled"
make_env
echo '{"telegram":{"enabled":true,"botToken":"x"}}' > "$TMP/config.json"
start_watchdog
wait_for 20 count_at_least 1 && ok "watcher launched (count=$(count))" || bad "watcher never launched"
touch "$TMP/die"      # cause a clean exit 0
wait_for 25 count_at_least 2 \
  && ok "watcher restarted after exit 0 (count=$(count))" || bad "NOT restarted after exit 0 (count=$(count))"
stop_watchdog
rm -rf "$TMP"

# --- Test B: outbound stall self-heal ---
echo "Test B: stale outbound heartbeat triggers loud log + restart"
make_env
echo '{"telegram":{"enabled":true,"botToken":"x"}}' > "$TMP/config.json"
start_watchdog
# Assert the launch rather than swallowing it. If the watcher never came up, BEFORE would
# sample 0 and the FINAL count_above check could then pass on the watcher's first-ever
# launch instead of on a stall-triggered restart — a pass for the wrong reason, in the one
# test whose job is to detect a missing restart.
wait_for 20 count_at_least 1 \
  && ok "watcher up before stall (count=$(count))" || bad "watcher never launched — Test B preconditions not met"
BEFORE="$(count)"
touch "$TMP/stall-outbound"   # watcher keeps inbound HB fresh, stops outbound HB
wait_for 30 log_has "OUTBOUND relay STALLED" \
  && ok "logged outbound stall loudly" || bad "no loud outbound-stall log"
# Safe to clear only AFTER detection: clearing earlier lets the outbound HB refresh and
# no stall is ever detected. The kill+relaunch is already committed at this point.
rm -f "$TMP/stall-outbound"
wait_for 30 count_above "$BEFORE" \
  && ok "watcher restarted on outbound stall (count=$(count) > $BEFORE)" || bad "NOT restarted on outbound stall (count=$(count))"
stop_watchdog
rm -rf "$TMP"

# --- Test C: disabled => stop ---
echo "Test C: telegram disabled => watchdog exits without launching"
make_env
echo '{"telegram":{"enabled":false}}' > "$TMP/config.json"
start_watchdog
sleep 2
if kill -0 "$WD_PID" 2>/dev/null; then bad "watchdog still running with telegram disabled"; else ok "watchdog exited"; fi
[ "$(count)" -eq 0 ] && ok "watcher never launched when disabled" || bad "watcher launched despite disabled (count=$(count))"
grep -q "telegram disabled" "$TMP/logs/telegram-watcher.log" && ok "logged disabled reason" || bad "no disabled log"
stop_watchdog
rm -rf "$TMP"

# --- Test D: singleton guard (no duplicate watchdogs) ---
echo "Test D: a second watchdog refuses to start while one is running"
make_env
echo '{"telegram":{"enabled":true,"botToken":"x"}}' > "$TMP/config.json"
start_watchdog; WD1=$WD_PID
sleep 3
[ "$(count)" -ge 1 ] && ok "first watchdog launched watcher (count=$(count))" || bad "first watchdog never launched watcher"
BEFORE="$(count)"
# Start a second watchdog with the same SUPERBOT2_HOME
SUPERBOT2_HOME="$TMP" TELEGRAM_WATCHER_SCRIPT="$TMP/fake-watcher.mjs" \
  TELEGRAM_HEALTH_CHECK_INTERVAL=1 bash "$WATCHDOG" &
WD2=$!
sleep 2
if kill -0 "$WD2" 2>/dev/null; then bad "second watchdog kept running (no singleton guard)"; else ok "second watchdog exited (singleton guard)"; fi
grep -q "another watchdog already running" "$TMP/logs/telegram-watcher.log" && ok "logged duplicate-watchdog refusal" || bad "no duplicate-watchdog log"
# First watchdog's watcher must be untouched (its pid file still valid)
kill "$WD1" 2>/dev/null; kill "$WD2" 2>/dev/null
wait "$WD1" 2>/dev/null; wait "$WD2" 2>/dev/null
pkill -f "$TMP/fake-watcher.mjs" 2>/dev/null
rm -rf "$TMP"

# --- Test E: C1 orphan-reaper cwd anchor — sibling checkout NOT reaped, same-repo IS ---
# Regression test: the pre-fix pattern "$REPO_DIR"* (no trailing slash) matched a sibling
# checkout like "$REPO_DIR-staging/…", which could TERM a live dashboard from a different
# checkout. The fix anchors at a path separator: only exact repo or subpath qualifies.
echo "Test E: orphan reaper cwd anchoring — sibling checkout not matched, same-repo cwd is"
is_orphaned_in_repo_check() {
  # Replicate the fixed is_orphaned_in_repo cwd condition for unit-testing in isolation.
  # Returns 0 (match/eligible) if cwd is the repo or a strict subpath; 1 otherwise.
  local REPO_DIR="$1"
  local cwd="$2"
  [[ -n "$cwd" && ( "$cwd" == "$REPO_DIR" || "$cwd" == "$REPO_DIR/"* ) ]]
}
FAKE_REPO="/Users/jeff/.superbot2-app"
# Should NOT match: sibling checkout paths (prefix collision without path sep anchor)
is_orphaned_in_repo_check "$FAKE_REPO" "${FAKE_REPO}-staging/dashboard-ui" \
  && bad "sibling checkout '${FAKE_REPO}-staging/dashboard-ui' incorrectly matched (C1 bug present)" \
  || ok  "sibling checkout '${FAKE_REPO}-staging/dashboard-ui' not matched (C1 fixed)"
is_orphaned_in_repo_check "$FAKE_REPO" "${FAKE_REPO}-worktree" \
  && bad "sibling '${FAKE_REPO}-worktree' incorrectly matched (C1 bug present)" \
  || ok  "sibling '${FAKE_REPO}-worktree' not matched (C1 fixed)"
# Should match: exact repo cwd and subpaths under it
is_orphaned_in_repo_check "$FAKE_REPO" "$FAKE_REPO" \
  && ok  "exact repo cwd '$FAKE_REPO' matched (eligible for reaping)" \
  || bad "exact repo cwd '$FAKE_REPO' not matched — should be eligible"
is_orphaned_in_repo_check "$FAKE_REPO" "$FAKE_REPO/dashboard-ui" \
  && ok  "subpath '$FAKE_REPO/dashboard-ui' matched (eligible for reaping)" \
  || bad "subpath '$FAKE_REPO/dashboard-ui' not matched — should be eligible"
is_orphaned_in_repo_check "$FAKE_REPO" "$FAKE_REPO/scripts" \
  && ok  "subpath '$FAKE_REPO/scripts' matched (eligible for reaping)" \
  || bad "subpath '$FAKE_REPO/scripts' not matched — should be eligible"
# Empty cwd must NOT match (proc_cwd returned nothing — skip the proc)
is_orphaned_in_repo_check "$FAKE_REPO" "" \
  && bad "empty cwd incorrectly matched (should skip the proc)" \
  || ok  "empty cwd correctly rejected"

echo
echo "RESULTS: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
