#!/bin/bash
# write-session.sh - Write a session summary for the dashboard Recent Activity feed
# Usage: write-session.sh <space> <project> <worker> --summary "what was done" [options]
#
# Options:
#   --summary "brief description" (required)
#   --files "path/to/file1,path/to/file2" (comma-separated, optional)
#
# Examples:
#   write-session.sh auth jwt-refresh auth-worker \
#     --summary "Implemented token blacklist using Redis. Added tests." \
#     --files "src/auth/blacklist.ts,src/auth/__tests__/blacklist.test.ts"

set -uo pipefail

SPACE="${1:-}"
PROJECT="${2:-}"
WORKER="${3:-}"
shift 3 2>/dev/null || true

if [[ -z "$SPACE" || -z "$PROJECT" || -z "$WORKER" ]]; then
  echo "Usage: write-session.sh <space> <project> <worker> --summary \"...\" [--files \"...\"]" >&2
  exit 1
fi

SUMMARY=""
FILES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --summary) SUMMARY="$2"; shift 2 ;;
    --files) FILES="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$SUMMARY" ]]; then
  echo "Error: --summary is required" >&2
  exit 1
fi

DIR="${SUPERBOT2_HOME:-$HOME/.superbot2}"
SESSIONS_DIR="$DIR/sessions"
mkdir -p "$SESSIONS_DIR"

TIMESTAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
ISO_TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Build files array
if [[ -n "$FILES" ]]; then
  FILES_JSON=$(echo "$FILES" | tr ',' '\n' | jq -R . | jq -s .)
else
  FILES_JSON="[]"
fi

# ── Collision handling: publish by ATOMIC LINK, never check-then-write ──────────────
# The filename has SECOND resolution, so concurrent workers routinely target the same
# name. Two earlier attempts were both wrong:
#   1. No guard at all — the second writer silently overwrote the first (live 2026-08-24:
#      two summaries batched into one command, the first lost with no warning).
#   2. A `while [[ -e "$FILE" ]]` suffix loop — check-then-write, with FILES_JSON and a
#      jq spawn sitting between the test and the redirect. That closes the SEQUENTIAL
#      case only. Measured 2026-08-27 with 15 concurrent invocations, 4 reps: 4-9
#      summaries LOST per rep, and twice a file of interleaved, INVALID JSON. The
#      corruption is silent downstream too — dashboard/server.js /api/sessions does
#      readJsonFile then `if (!session) continue`, so a corrupt session file is skipped
#      without error and simply disappears from Recent Activity.
#
# `ln` is the fix because link(2) fails with EEXIST if the target exists. That makes
# claiming the name and publishing the complete content ONE atomic step: a reader either
# does not see the file, or sees it whole. Note that `mv` alone would NOT be enough —
# rename(2) silently REPLACES an existing target, so it cures torn writes but not lost
# ones. The temp file is created in $SESSIONS_DIR so the link stays within one
# filesystem, and its name is dot-prefixed and not *.json so no reader ever picks it up.
TMPFILE="$(mktemp "$SESSIONS_DIR/.session-XXXXXX")" || {
  echo "Error: could not create a temp file in $SESSIONS_DIR" >&2; exit 1; }
trap 'rm -f "$TMPFILE"' EXIT

_n=0
while :; do
  if (( _n == 0 )); then SESSION_ID="session-${TIMESTAMP}"; else SESSION_ID="session-${TIMESTAMP}-${_n}"; fi
  FILE="$SESSIONS_DIR/${SESSION_ID}.json"

  # Rendered per attempt because the id must match the filename we end up claiming.
  jq -n \
    --arg id "$SESSION_ID" \
    --arg space "$SPACE" \
    --arg project "$PROJECT" \
    --arg summary "$SUMMARY" \
    --argjson filesChanged "$FILES_JSON" \
    --arg completedAt "$ISO_TIMESTAMP" \
    --arg worker "$WORKER" \
    '{
      id: $id,
      space: $space,
      project: $project,
      summary: $summary,
      filesChanged: $filesChanged,
      completedAt: $completedAt,
      worker: $worker
    }' > "$TMPFILE" || { echo "Error: failed to render session JSON" >&2; exit 1; }

  # The only step that can publish. Loses the race -> EEXIST -> try the next suffix.
  ln "$TMPFILE" "$FILE" 2>/dev/null && break

  _n=$((_n + 1))
  if (( _n > 10000 )); then
    echo "Error: could not claim a session filename after 10000 attempts" >&2
    exit 1
  fi
done

echo "Wrote session: $FILE"
