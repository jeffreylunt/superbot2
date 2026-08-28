#!/bin/bash
# Tests for scripts/write-session.sh session-filename collision handling.
#
# Two incidents, two different mechanisms, both silent:
#   1. 2026-08-24 (live): no guard at all. Two summaries written in the same second —
#      two workers' summaries batched into one command — and the second overwrote the
#      first. The first was lost with NO warning.
#   2. 2026-08-27: the fix for (1) was a `while [[ -e "$FILE" ]]` suffix loop, i.e.
#      check-then-write, with FILES_JSON and a jq spawn between the test and the
#      redirect. That closes the SEQUENTIAL case only. Measured with 15 concurrent
#      invocations: 4-9 summaries LOST per run, and interleaved writes onto one path
#      produced syntactically INVALID JSON. Both losses are invisible downstream —
#      dashboard/server.js /api/sessions does readJsonFile then `if (!session) continue`,
#      so a corrupt session file is skipped without error and vanishes from Recent
#      Activity.
#
# The fix under test publishes by ATOMIC LINK: content is rendered to a dot-prefixed temp
# file in the same directory, then `ln` claims the final name. link(2) fails with EEXIST if
# the name is taken, so claiming and publishing are one atomic step and a reader sees the
# file either absent or whole. `mv` would NOT be sufficient: rename(2) silently REPLACES an
# existing target, curing torn writes but not lost ones.
#
# Every case runs the REAL script against an isolated SUPERBOT2_HOME.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WRITE_SESSION="$SCRIPT_DIR/../scripts/write-session.sh"
PASS=0
FAIL=0

ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

make_home() { TMP="$(mktemp -d)"; SESSIONS="$TMP/sessions"; }
cleanup()   { rm -rf "$TMP"; }

json_files()  { ls "$SESSIONS" 2>/dev/null | grep -c '\.json$' | tr -d ' '; }
# Temp files are dot-prefixed and NOT *.json so no reader can pick one up mid-write;
# none should survive a completed run either.
stray_tmp()   { ls -a "$SESSIONS" 2>/dev/null | grep -c '^\.session-' | tr -d ' '; }
invalid_json() {
  local n=0 f
  for f in "$SESSIONS"/*.json; do
    [ -e "$f" ] || continue
    jq -e . "$f" >/dev/null 2>&1 || n=$((n+1))
  done
  echo "$n"
}
distinct() {  # distinct values of a jq field across all valid session files
  local field="$1" f out=""
  for f in "$SESSIONS"/*.json; do
    [ -e "$f" ] || continue
    jq -e . "$f" >/dev/null 2>&1 && out="$out$(jq -r ".$field" "$f")
"
  done
  printf '%s' "$out" | sort -u | grep -c . | tr -d ' '
}

# Fire N invocations at once into the same SUPERBOT2_HOME.
fire_concurrent() {
  local n="$1" i
  for i in $(seq 1 "$n"); do
    SUPERBOT2_HOME="$TMP" bash "$WRITE_SESSION" sp pr "worker$i" \
      --summary "summary number $i" >/dev/null 2>&1 &
  done
  wait
}

# ── Test 1: N concurrent writers all survive, N=15, repeated ──────────────────────
# Repeated because a race that is merely UNLIKELY passes once and still loses data in
# production. The pre-fix code failed this on every single rep.
N=15
for rep in 1 2 3; do
  echo "Test 1.$rep: $N concurrent writers — none lost, none corrupted"
  make_home
  fire_concurrent "$N"
  [ "$(json_files)" -eq "$N" ] \
    && ok "$N files written (no summaries lost)" \
    || bad "expected $N files, got $(json_files) — $((N - $(json_files))) summaries LOST"
  [ "$(invalid_json)" -eq 0 ] \
    && ok "every file is valid JSON" || bad "$(invalid_json) file(s) contain invalid JSON"
  [ "$(distinct id)" -eq "$N" ] \
    && ok "$N distinct session ids" || bad "expected $N distinct ids, got $(distinct id)"
  [ "$(distinct summary)" -eq "$N" ] \
    && ok "all $N distinct summaries survived" \
    || bad "expected $N distinct summaries, got $(distinct summary)"
  [ "$(stray_tmp)" -eq 0 ] \
    && ok "no temp files left behind" || bad "$(stray_tmp) temp file(s) left in sessions dir"
  cleanup
done

# ── Test 2: the 2026-08-24 SEQUENTIAL shape must not regress ──────────────────────
# Two summaries in one command, same second. The FIRST one is the one that was lost.
echo "Test 2: two sequential same-second writes — the FIRST summary still survives"
make_home
SUPERBOT2_HOME="$TMP" bash "$WRITE_SESSION" spA prA workerA --summary "FIRST must survive" >/dev/null 2>&1
SUPERBOT2_HOME="$TMP" bash "$WRITE_SESSION" spB prB workerB --summary "SECOND"             >/dev/null 2>&1
[ "$(json_files)" -eq 2 ] && ok "both files written" || bad "expected 2 files, got $(json_files)"
grep -q "FIRST must survive" "$SESSIONS"/*.json 2>/dev/null \
  && ok "the FIRST summary survived (2026-08-24 regression)" || bad "the FIRST summary was LOST"
[ "$(distinct id)" -eq 2 ] && ok "the two ids are distinct" || bad "ids collided"
cleanup

# ── Test 3: a single write is unchanged — no suffix, id matches the filename ───────
echo "Test 3: a lone write is unsuffixed and its id matches its filename"
make_home
SUPERBOT2_HOME="$TMP" bash "$WRITE_SESSION" sp pr solo --summary "only one" >/dev/null 2>&1
ONLY="$(ls "$SESSIONS"/*.json 2>/dev/null | head -1)"
[ -n "$ONLY" ] && ok "file written" || bad "no file written"
if [ -n "$ONLY" ]; then
  BASE="$(basename "$ONLY" .json)"
  [ "$(jq -r .id "$ONLY")" = "$BASE" ] \
    && ok "id matches filename ($BASE)" || bad "id $(jq -r .id "$ONLY") != filename $BASE"
  case "$BASE" in
    *-[0-9]) bad "a lone write picked up a collision suffix ($BASE)" ;;
    *)       ok "no collision suffix on a lone write" ;;
  esac
fi
cleanup

echo
echo "RESULTS: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
