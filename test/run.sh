#!/bin/bash
# Runs the telegram reliability test suite.
# The .mjs integration tests spawn real watcher subprocesses + mock servers, so they
# must run SEQUENTIALLY (--test-concurrency=1) to avoid port/timing races.
#
# ── HOW TO READ THIS RUNNER'S RESULT (2026-08-27) ────────────────────────────────
# It exits NON-ZERO if any suite fails, and it runs EVERY suite even after one fails.
# It previously used `set -e`, which aborted at the FIRST failing suite: a red run then
# looked like a short or truncated one, and you never learned what else was broken.
#
# DO NOT PIPE THIS SCRIPT. `bash test/run.sh 2>&1 | tail -30` reports the exit code of
# `tail`, not of the suite — that pipe is exactly what produced a false green on
# 2026-08-27 (a real "NOT restarted on outbound stall" failure was reported as success).
# Redirect and read $? instead:
#     bash test/run.sh > out.log 2>&1; echo "exit=$?"
# If you must pipe, read the final "SUITE RESULT:" line, which is always printed last.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"

SUITE_TOTAL=0
SUITE_FAILED=0
FAILED_NAMES=""

# Run one suite, record its result, and keep going. Never aborts the run.
run_suite() {
  local name="$1"
  shift
  SUITE_TOTAL=$((SUITE_TOTAL + 1))
  echo
  echo "=== $name ==="
  if "$@"; then
    echo "--- $name: OK"
  else
    local rc=$?
    echo "--- $name: FAILED (exit $rc)"
    SUITE_FAILED=$((SUITE_FAILED + 1))
    FAILED_NAMES="$FAILED_NAMES
    - $name"
  fi
}

run_suite "watchdog (bash) tests"                     bash "$DIR/telegram-watchdog.test.sh"
run_suite "orchestrator-watchdog (bash) tests"        bash "$DIR/orchestrator-watchdog.test.sh"
run_suite "launcher single-instance guard (bash) tests" bash "$DIR/launcher-guard.test.sh"
run_suite "dashboard orphan-reaper (bash) tests"      bash "$DIR/dashboard-reaper.test.sh"
run_suite "heartbeat rotation-proofing (bash) tests"  bash "$DIR/heartbeat-rotation.test.sh"
run_suite "scheduler catch-up + self-guard (bash) tests" bash "$DIR/scheduler-catchup.test.sh"
run_suite "update-task.sh notes safety (bash) tests"  bash "$DIR/update-task-notes.test.sh"
run_suite "write-session.sh collision handling (bash) tests" bash "$DIR/write-session-concurrency.test.sh"

run_suite "unit (node) tests" \
  node --test --test-concurrency=1 \
  "$DIR/relay-filter.test.mjs" \
  "$DIR/active-team-inbox.test.mjs" \
  "$DIR/live-team-dir-proc-start.test.mjs" \
  "$DIR/ensure-dashboard-user.test.mjs" \
  "$DIR/inbound-message-write.test.mjs" \
  "$DIR/orchestrator-wake-nudge.test.mjs" \
  "$DIR/inbox-migration.test.mjs"

run_suite "watcher (node) integration tests" \
  node --test --test-concurrency=1 \
  "$DIR/telegram-watcher-active-inbox.test.mjs" \
  "$DIR/telegram-watcher-typing.test.mjs" \
  "$DIR/telegram-watcher-tg.test.mjs" \
  "$DIR/telegram-watcher-nodrop.test.mjs"

echo
echo "======================================================================"
if [ "$SUITE_FAILED" -eq 0 ]; then
  echo "SUITE RESULT: PASS — all $SUITE_TOTAL suites passed"
  echo "======================================================================"
  exit 0
fi
echo "SUITE RESULT: FAIL — $SUITE_FAILED of $SUITE_TOTAL suites failed:$FAILED_NAMES"
echo "======================================================================"
exit 1
