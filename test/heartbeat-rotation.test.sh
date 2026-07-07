#!/bin/bash
# Tests for heartbeat-cron.sh lossless team-lead writes (rotation-proofing).
#
# Incident (2026-07-04 18:0x): the team dir resolved at script start was deleted by a
# session rotation before the write. The write then hit "No such file or directory" and
# could seed a zombie dir. Fix: re-resolve the live team AT WRITE TIME; route to whatever
# team is live now; if none is, skip WITHOUT saving the fingerprint (so the next run
# redelivers) and never recreate the dead/zombie dir.
#
# Each case runs the REAL heartbeat against an isolated HOME/SUPERBOT2_HOME. `node` (used
# only for team resolution) is shimmed so we control exactly which team each resolution
# returns — including a rotation that happens BETWEEN the start-of-run resolution and the
# write. HOME is pointed at the temp dir so the PATH shim wins and the pid file is isolated.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HEARTBEAT="$SCRIPT_DIR/../scripts/heartbeat-cron.sh"
PATH_ORIG="$PATH"
PASS=0
FAIL=0

ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

# Create an isolated home with empty escalation/knowledge/space trees (empty is fine — the
# fingerprint is "empty" on a first run, which still counts as a change and writes a heartbeat).
make_home() {
  TMP="$(mktemp -d)"
  HOMEDIR="$TMP/home"
  TEAMS="$HOMEDIR/.claude/teams"
  mkdir -p "$TMP/bin" "$TEAMS" "$HOMEDIR/logs" \
           "$HOMEDIR/escalations/untriaged" "$HOMEDIR/escalations/needs_human" \
           "$HOMEDIR/escalations/resolved" "$HOMEDIR/knowledge" "$HOMEDIR/spaces"
}

# Make a live team dir (real config.json + an empty inbox array).
make_team() {
  local name="$1"
  mkdir -p "$TEAMS/$name/inboxes"
  echo '{"name":"'"$name"'"}' > "$TEAMS/$name/config.json"
  echo '[]' > "$TEAMS/$name/inboxes/team-lead.json"
  echo "$TEAMS/$name"
}

run_heartbeat() {
  # HOME=$TMP so (a) the PATH shim below wins over real node and (b) the singleton pid file
  # ($HOME/.superbot2/.pids) is isolated. SUPERBOT2_HOME is the state dir the heartbeat scans.
  HOME="$TMP" PATH="$TMP/bin:$PATH_ORIG" SUPERBOT2_HOME="$HOMEDIR" SUPERBOT2_NAME="superbot2" \
    bash "$HEARTBEAT" > "$TMP/out.log" 2>&1
  echo $?
}

inbox_count() { jq '[.[] | select(.type == "heartbeat")] | length' "$1" 2>/dev/null || echo 0; }
cleanup() { rm -rf "$TMP"; }

# ── Test 1: normal path — one stable live team, message delivered, fingerprint saved ──
echo "Test 1: normal heartbeat writes to the live team and saves the fingerprint"
make_home
TEAM_A="$(make_team team-a)"
cat > "$TMP/bin/node" <<EOF
#!/bin/bash
printf '%s' "$TEAM_A"
EOF
chmod +x "$TMP/bin/node"
RC="$(run_heartbeat)"
[ "$RC" = "0" ] && ok "exited 0" || bad "non-zero exit ($RC): $(tail -1 "$TMP/out.log")"
[ "$(inbox_count "$TEAM_A/inboxes/team-lead.json")" -ge 1 ] \
  && ok "heartbeat delivered to live team inbox" || bad "no heartbeat in live team inbox"
[ -f "$HOMEDIR/.heartbeat-last-fingerprint" ] \
  && ok "fingerprint saved on normal path" || bad "fingerprint NOT saved on normal path"
cleanup

# ── Test 2: rotation to NO live team — skip cleanly, no zombie dir, fingerprint NOT saved ──
echo "Test 2: rotation deletes the team mid-run → skipped with a log line, no zombie dir"
make_home
TEAM_A="$(make_team team-a)"
# node call 1 (start-of-run) → team-a; call 2 (write time) → simulate rotation: delete
# team-a and resolve to nothing (no live team).
cat > "$TMP/bin/node" <<EOF
#!/bin/bash
CNT="$TMP/node-callcount"
n=\$(( \$(cat "\$CNT" 2>/dev/null || echo 0) + 1 ))
echo "\$n" > "\$CNT"
if [ "\$n" -le 1 ]; then printf '%s' "$TEAM_A"; else rm -rf "$TEAM_A"; fi
EOF
chmod +x "$TMP/bin/node"
RC="$(run_heartbeat)"
[ "$RC" = "0" ] && ok "exited 0 (no crash) despite vanished team" || bad "non-zero exit ($RC): $(tail -3 "$TMP/out.log")"
grep -q "no live team at write time" "$TMP/out.log" \
  && ok "logged the skip" || bad "no skip log line ($(tail -2 "$TMP/out.log"))"
[ ! -e "$TEAM_A" ] && ok "vanished team dir NOT recreated (no zombie)" || bad "zombie team dir recreated at $TEAM_A"
[ ! -f "$HOMEDIR/.heartbeat-last-fingerprint" ] \
  && ok "fingerprint NOT saved on skip (state redelivers next run)" || bad "fingerprint saved on skip — state would be lost"
cleanup

# ── Test 3: rotation to ANOTHER live team — write follows the rotation to the new team ──
echo "Test 3: rotation to a new live team mid-run → message reaches the NEW team"
make_home
TEAM_A="$(make_team team-a)"
TEAM_B="$(make_team team-b)"
cat > "$TMP/bin/node" <<EOF
#!/bin/bash
CNT="$TMP/node-callcount"
n=\$(( \$(cat "\$CNT" 2>/dev/null || echo 0) + 1 ))
echo "\$n" > "\$CNT"
if [ "\$n" -le 1 ]; then printf '%s' "$TEAM_A"; else printf '%s' "$TEAM_B"; fi
EOF
chmod +x "$TMP/bin/node"
RC="$(run_heartbeat)"
[ "$RC" = "0" ] && ok "exited 0" || bad "non-zero exit ($RC): $(tail -3 "$TMP/out.log")"
[ "$(inbox_count "$TEAM_B/inboxes/team-lead.json")" -ge 1 ] \
  && ok "heartbeat delivered to the NEW live team (team-b)" || bad "heartbeat did not reach team-b"
[ "$(inbox_count "$TEAM_A/inboxes/team-lead.json")" -eq 0 ] \
  && ok "start-of-run team (team-a) NOT written (no stale delivery)" || bad "message wrongly landed in team-a"
cleanup

echo
echo "RESULTS: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
