#!/bin/bash
# Tests for scripts/reap-orphaned-dashboards.sh — the orphan-dashboard reaper the superbot2
# launcher runs on start. Regression target (three duplicate trees observed 2026-07-04): a
# SIGKILL'd launcher leaves `npm run dev` (PPID 1) → concurrently → npm run dev:api → node
# server.js. Only the npm ROOT is a true orphan; the old reaper checked concurrently/server.js
# at PPID 1 and never matched, so a full duplicate tree survived every restart.
#
# Each fixture spawns a REAL process tree with argv[0]="npm run dev" (via `exec -a`) and a
# child argv[0]="concurrently", inside a temp "repo" dir. Orphans are reparented to PID 1 by
# a launcher that backgrounds the tree then exits. The reaper is scoped to the temp repo, so
# the machine's real dashboards (a different cwd) are never touched.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../scripts/reap-orphaned-dashboards.sh"
PASS=0
FAIL=0

ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

# pwd -P: resolve /var → /private/var so the repo path matches lsof's physical cwd (macOS).
TMP="$(cd "$(mktemp -d)" && pwd -P)"
FAKE_REPO="$TMP/repo"
mkdir -p "$FAKE_REPO/dashboard-ui" "${FAKE_REPO}-staging/dashboard-ui"

# Launcher that spawns a fake dashboard tree (root "npm run dev" + child "concurrently") in
# $1, records "root\nchild" pids to $2, then EXITS — orphaning the tree to PID 1.
cat > "$TMP/spawn.sh" <<'EOF'
#!/bin/bash
cd "$1" || exit 1
(
  exec -a "npm run dev" bash -c '
    echo $$ > "$0"
    ( exec -a "concurrently" sleep 600 ) &
    echo $! >> "$0"
    wait
  ' "$2"
) &
# launcher exits here; the backgrounded subshell (now "npm run dev") reparents to PID 1
EOF
chmod +x "$TMP/spawn.sh"

spawn_orphan() { bash "$TMP/spawn.sh" "$1" "$2"; }   # returns immediately; tree reparents to 1
root_pid()  { sed -n '1p' "$1"; }
child_pid() { sed -n '2p' "$1"; }
alive()     { kill -0 "$1" 2>/dev/null; }

# Two orphaned in-repo trees (simulating two accumulated SIGKILL'd launchers)…
spawn_orphan "$FAKE_REPO/dashboard-ui" "$TMP/o1.pids"
spawn_orphan "$FAKE_REPO/dashboard-ui" "$TMP/o2.pids"
# …a sibling-checkout orphan that must NOT be reaped (cwd outside the repo)…
spawn_orphan "${FAKE_REPO}-staging/dashboard-ui" "$TMP/sib.pids"
# …and a LIVE in-repo tree whose parent (this test) is alive — the fresh launcher's dashboard.
( cd "$FAKE_REPO/dashboard-ui" && exec -a "npm run dev" bash -c 'echo $$ > "$0"; ( exec -a "concurrently" sleep 600 ) & echo $! >> "$0"; wait' "$TMP/live.pids" ) &
LIVE_LAUNCHER=$!
disown "$LIVE_LAUNCHER" 2>/dev/null || true   # silence job-control "Terminated" notice on cleanup

sleep 1.5   # let execs settle and pid files fill

O1_ROOT=$(root_pid "$TMP/o1.pids");  O1_CHILD=$(child_pid "$TMP/o1.pids")
O2_ROOT=$(root_pid "$TMP/o2.pids");  O2_CHILD=$(child_pid "$TMP/o2.pids")
SIB_ROOT=$(root_pid "$TMP/sib.pids")
LIVE_ROOT=$(root_pid "$TMP/live.pids"); LIVE_CHILD=$(child_pid "$TMP/live.pids")

# Sanity: everything is up, and the orphans really are at PPID 1 (guards against a bad fixture)
echo "Fixture: orphan1=$O1_ROOT orphan2=$O2_ROOT sibling=$SIB_ROOT live=$LIVE_ROOT"
[ "$(ps -o ppid= -p "$O1_ROOT" 2>/dev/null | tr -d ' ')" = "1" ] \
  && ok "orphan tree reparented to PID 1 (fixture valid)" || bad "orphan not at PPID 1 — fixture broken"
[ "$(ps -o ppid= -p "$LIVE_ROOT" 2>/dev/null | tr -d ' ')" != "1" ] \
  && ok "live tree has a live parent (fixture valid)" || bad "live tree already orphaned — fixture broken"

# ── Run the reaper, scoped to the fake repo ──
reap_orphaned_dashboards "$FAKE_REPO"
sleep 1   # let SIGTERM land

# Orphaned in-repo trees (roots AND children) must be gone → only the live tree remains.
alive "$O1_ROOT"  && bad "orphan1 root survived reaping" || ok "orphan1 root reaped"
alive "$O1_CHILD" && bad "orphan1 child survived (kill_tree didn't recurse)" || ok "orphan1 child reaped (tree walked)"
alive "$O2_ROOT"  && bad "orphan2 root survived reaping" || ok "orphan2 root reaped"
alive "$O2_CHILD" && bad "orphan2 child survived" || ok "orphan2 child reaped"

# Guards: sibling checkout and live-launcher trees must be untouched.
alive "$SIB_ROOT"  && ok "sibling-checkout tree NOT reaped (cwd guard)" || bad "sibling-checkout tree wrongly reaped"
alive "$LIVE_ROOT" && ok "live-launcher tree NOT reaped (PPID guard)" || bad "live-launcher tree wrongly reaped"

# Post-condition for the acceptance criterion: exactly ONE dashboard tree remains (the live one).
SURVIVORS=0
for p in "$O1_ROOT" "$O2_ROOT" "$LIVE_ROOT"; do alive "$p" && SURVIVORS=$((SURVIVORS+1)); done
[ "$SURVIVORS" -eq 1 ] && ok "exactly one dashboard tree remains after reap" || bad "$SURVIVORS dashboard trees remain (expected 1)"

# ── Cleanup: kill everything the fixture spawned ──
kill "$LIVE_LAUNCHER" 2>/dev/null || true
for p in "$O1_ROOT" "$O1_CHILD" "$O2_ROOT" "$O2_CHILD" "$SIB_ROOT" "$LIVE_ROOT" "$LIVE_CHILD"; do
  [ -n "$p" ] && kill "$p" 2>/dev/null || true
done
rm -rf "$TMP"

echo
echo "RESULTS: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
