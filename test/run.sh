#!/bin/bash
# Runs the telegram reliability test suite.
# The .mjs integration tests spawn real watcher subprocesses + mock servers, so they
# must run SEQUENTIALLY (--test-concurrency=1) to avoid port/timing races.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== watchdog (bash) tests ==="
bash "$DIR/telegram-watchdog.test.sh"

echo
echo "=== orchestrator-watchdog (bash) tests ==="
bash "$DIR/orchestrator-watchdog.test.sh"

echo
echo "=== launcher single-instance guard (bash) tests ==="
bash "$DIR/launcher-guard.test.sh"

echo
echo "=== dashboard orphan-reaper (bash) tests ==="
bash "$DIR/dashboard-reaper.test.sh"

echo
echo "=== heartbeat rotation-proofing (bash) tests ==="
bash "$DIR/heartbeat-rotation.test.sh"

echo
echo "=== unit (node) tests ==="
node --test --test-concurrency=1 \
  "$DIR/active-team-inbox.test.mjs" \
  "$DIR/ensure-dashboard-user.test.mjs" \
  "$DIR/inbound-message-write.test.mjs" \
  "$DIR/orchestrator-wake-nudge.test.mjs" \
  "$DIR/inbox-migration.test.mjs"

echo
echo "=== watcher (node) integration tests ==="
node --test --test-concurrency=1 \
  "$DIR/telegram-watcher-active-inbox.test.mjs" \
  "$DIR/telegram-watcher-typing.test.mjs" \
  "$DIR/telegram-watcher-tg.test.mjs" \
  "$DIR/telegram-watcher-nodrop.test.mjs"
