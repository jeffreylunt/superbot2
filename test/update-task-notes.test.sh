#!/bin/bash
# Tests for update-task.sh notes safety.
#
# Incident (multiple, 2026-08-22 and 2026-08-25): `--notes` REPLACED completionNotes
# wholesale with no backup and no git history under the task tree, destroying prior
# workers' field evidence twice. Fix: `--notes` now REFUSES to overwrite non-empty
# completionNotes unless `--force-notes` is also passed; `--append-notes` adds to
# existing notes under a dated separator; `--status` is now optional for a notes-only
# update (it was previously required even when only annotating a task).
#
# Each case runs the REAL script against an isolated SUPERBOT2_HOME/task fixture — never
# a real task file.
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UPDATE_TASK="$SCRIPT_DIR/../scripts/update-task.sh"
PASS=0
FAIL=0

ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

make_home() {
  TMP="$(mktemp -d)"
  HOMEDIR="$TMP/home"
  TASKDIR="$HOMEDIR/spaces/testspace/plans/testproj/tasks"
  mkdir -p "$TASKDIR"
}

# Write a fixture task. $1 = completionNotes value, or "null" for no prior notes.
make_task() {
  local notes_json="$1"
  cat > "$TASKDIR/task-repro.json" <<EOF
{
  "id": "task-repro", "subject": "t", "description": "d", "acceptanceCriteria": [],
  "status": "in_progress", "priority": "medium", "labels": [], "blocks": [], "blockedBy": [],
  "createdAt": "2026-08-25T00:00:00Z", "updatedAt": "2026-08-25T00:00:00Z",
  "completedAt": null, "completionNotes": $notes_json
}
EOF
}

run_ut() {
  SUPERBOT2_HOME="$HOMEDIR" bash "$UPDATE_TASK" testspace testproj task-repro "$@" \
    > "$TMP/out.log" 2>&1
  echo $?
}

notes_of() { jq -r '.completionNotes // "null"' "$TASKDIR/task-repro.json"; }
cleanup() { rm -rf "$TMP"; }

ORIGINAL='"ORIGINAL FIELD EVIDENCE: root cause was X. Do not re-run Y."'

# ── Test 1: bare --notes on a task with EXISTING non-empty notes must REFUSE ──
echo "Test 1: bare --notes refuses to overwrite existing non-empty completionNotes"
make_home
make_task "$ORIGINAL"
RC="$(run_ut --status in_progress --notes "clobber attempt")"
[ "$RC" != "0" ] && ok "non-zero exit ($RC)" || bad "exited 0 — should have refused"
[ "$(notes_of)" = "ORIGINAL FIELD EVIDENCE: root cause was X. Do not re-run Y." ] \
  && ok "original notes UNTOUCHED" || bad "original notes were overwritten: $(notes_of)"
cleanup

# ── Test 2: --append-notes preserves the original and adds the new text ──
echo "Test 2: --append-notes preserves original content and appends new text"
make_home
make_task "$ORIGINAL"
RC="$(run_ut --status in_progress --append-notes "follow-up note")"
[ "$RC" = "0" ] && ok "exited 0" || bad "non-zero exit ($RC): $(cat "$TMP/out.log")"
N="$(notes_of)"
echo "$N" | grep -q "ORIGINAL FIELD EVIDENCE" && ok "original text survived" || bad "original text lost"
echo "$N" | grep -q "follow-up note" && ok "new text present" || bad "new text missing"
cleanup

# ── Test 3: --notes --force-notes overwrites intentionally ──
echo "Test 3: --notes --force-notes overwrites on purpose"
make_home
make_task "$ORIGINAL"
RC="$(run_ut --status completed --notes "deliberate overwrite" --force-notes)"
[ "$RC" = "0" ] && ok "exited 0" || bad "non-zero exit ($RC): $(cat "$TMP/out.log")"
[ "$(notes_of)" = "deliberate overwrite" ] && ok "notes overwritten as requested" || bad "notes not overwritten: $(notes_of)"
[ "$(jq -r '.status' "$TASKDIR/task-repro.json")" = "completed" ] && ok "status set to completed" || bad "status not updated"
[ "$(jq -r '.completedAt' "$TASKDIR/task-repro.json")" != "null" ] && ok "completedAt set" || bad "completedAt not set"
cleanup

# ── Test 4: bare --notes on a task with NO prior notes still works (backward-compat) ──
echo "Test 4: bare --notes on empty completionNotes behaves exactly as before"
make_home
make_task "null"
RC="$(run_ut --status completed --notes "first-time notes")"
[ "$RC" = "0" ] && ok "exited 0" || bad "non-zero exit ($RC): $(cat "$TMP/out.log")"
[ "$(notes_of)" = "first-time notes" ] && ok "notes set" || bad "notes not set: $(notes_of)"
cleanup

# ── Test 5: notes-only update with NO --status leaves status/completedAt untouched ──
echo "Test 5: --append-notes without --status updates notes only"
make_home
make_task "$ORIGINAL"
RC="$(run_ut --append-notes "progress note, no status change")"
[ "$RC" = "0" ] && ok "exited 0" || bad "non-zero exit ($RC): $(cat "$TMP/out.log")"
[ "$(jq -r '.status' "$TASKDIR/task-repro.json")" = "in_progress" ] && ok "status unchanged" || bad "status was touched"
[ "$(jq -r '.completedAt' "$TASKDIR/task-repro.json")" = "null" ] && ok "completedAt unchanged" || bad "completedAt was touched"
notes_of | grep -q "progress note, no status change" && ok "notes updated" || bad "notes not updated"
cleanup

# ── Test 6: neither --status nor a notes flag still errors (old required-status contract) ──
echo "Test 6: no --status and no notes flag still errors"
make_home
make_task "$ORIGINAL"
RC="$(run_ut)"
[ "$RC" != "0" ] && ok "non-zero exit ($RC)" || bad "exited 0 with no flags at all"
cleanup

# ── Test 7: --notes and --append-notes together is rejected ──
echo "Test 7: --notes and --append-notes together errors"
make_home
make_task "null"
RC="$(run_ut --notes "a" --append-notes "b")"
[ "$RC" != "0" ] && ok "non-zero exit ($RC)" || bad "exited 0 with conflicting notes flags"
cleanup

# ── Test 8: invalid --status value still errors ──
echo "Test 8: invalid --status value still errors"
make_home
make_task "$ORIGINAL"
RC="$(run_ut --status bogus)"
[ "$RC" != "0" ] && ok "non-zero exit ($RC)" || bad "exited 0 with an invalid status"
cleanup

# ── Test 9: plain --status with no notes flag at all — most common historical call — unchanged ──
echo "Test 9: plain --status <value>, no notes flags, behaves exactly as before"
make_home
make_task "$ORIGINAL"
RC="$(run_ut --status pending)"
[ "$RC" = "0" ] && ok "exited 0" || bad "non-zero exit ($RC): $(cat "$TMP/out.log")"
[ "$(jq -r '.status' "$TASKDIR/task-repro.json")" = "pending" ] && ok "status updated" || bad "status not updated"
[ "$(notes_of)" = "ORIGINAL FIELD EVIDENCE: root cause was X. Do not re-run Y." ] \
  && ok "notes untouched (no notes flag passed)" || bad "notes were touched with no notes flag"
cleanup

echo
echo "RESULTS: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
