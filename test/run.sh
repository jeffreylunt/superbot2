#!/bin/bash
# Runs the telegram reliability test suite.
# The .mjs integration tests spawn real watcher subprocesses + mock servers, so they
# must run SEQUENTIALLY (--test-concurrency=1) to avoid port/timing races.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== watchdog (bash) tests ==="
bash "$DIR/telegram-watchdog.test.sh"

echo
echo "=== watcher (node) tests ==="
node --test --test-concurrency=1 \
  "$DIR/telegram-watcher-tg.test.mjs" \
  "$DIR/telegram-watcher-nodrop.test.mjs"
