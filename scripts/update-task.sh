#!/bin/bash
# update-task.sh - Update a task's status and metadata
# Usage: update-task.sh <space> <project> <task-id> [--status <status>] [options]
#
# Options:
#   --status pending|in_progress|completed
#     Required UNLESS a notes flag (--notes/--append-notes) is given, in which case
#     a notes-only update (status untouched) is allowed.
#   --notes "completion notes or status update"
#     SAFE BY DEFAULT: if completionNotes is already non-empty, this REFUSES rather
#     than overwriting it (a prior worker's notes are field evidence, not scratch
#     space). Use --append-notes to add to existing notes, or --force-notes to
#     overwrite intentionally.
#   --append-notes "text to add"
#     Appends to existing completionNotes under a dated separator. Safe to call
#     repeatedly; never discards prior content. If completionNotes is empty, this
#     just sets it (identical to --notes in that case).
#   --force-notes
#     Modifier for --notes: allows overwriting non-empty completionNotes. Has no
#     effect without --notes (--append-notes never needs it).
#
# Examples:
#   update-task.sh auth jwt-refresh task-2026-02-15T10-30-45Z --status in_progress
#
#   update-task.sh auth jwt-refresh task-2026-02-15T10-30-45Z --status completed \
#     --notes "Implemented token blacklist using Redis. Added tests for expiry."
#
#   update-task.sh auth jwt-refresh task-2026-02-15T10-30-45Z --status pending \
#     --notes "Blocked on Redis credentials"
#
#   update-task.sh auth jwt-refresh task-2026-02-15T10-30-45Z --append-notes \
#     "Follow-up: rotated the credentials, unblocking this."
#
#   update-task.sh auth jwt-refresh task-2026-02-15T10-30-45Z --status completed \
#     --notes "Corrected root cause" --force-notes

set -uo pipefail

SPACE="${1:-}"
PROJECT="${2:-}"
TASK_ID="${3:-}"
shift 3 2>/dev/null || true

if [[ -z "$SPACE" || -z "$PROJECT" || -z "$TASK_ID" ]]; then
  echo "Usage: update-task.sh <space> <project> <task-id> [--status <status>] [options]" >&2
  exit 1
fi

TASKS_DIR="${SUPERBOT2_HOME:-$HOME/.superbot2}/spaces/$SPACE/plans/$PROJECT/tasks"
FILE="$TASKS_DIR/$TASK_ID.json"

if [[ ! -f "$FILE" ]]; then
  echo "Task not found: $FILE" >&2
  exit 1
fi

# Parse options
STATUS=""
NOTES=""
NOTES_SET=0
APPEND_NOTES=""
APPEND_SET=0
FORCE_NOTES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --status) STATUS="$2"; shift 2 ;;
    --notes) NOTES="$2"; NOTES_SET=1; shift 2 ;;
    --append-notes) APPEND_NOTES="$2"; APPEND_SET=1; shift 2 ;;
    --force-notes) FORCE_NOTES=1; shift 1 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ $NOTES_SET -eq 1 && $APPEND_SET -eq 1 ]]; then
  echo "Error: --notes and --append-notes are mutually exclusive (use one, or --append-notes twice)" >&2
  exit 1
fi

if [[ -z "$STATUS" && $NOTES_SET -eq 0 && $APPEND_SET -eq 0 ]]; then
  echo "Error: --status is required (or pass --notes/--append-notes for a notes-only update)" >&2
  exit 1
fi

if [[ -n "$STATUS" && "$STATUS" != "pending" && "$STATUS" != "in_progress" && "$STATUS" != "completed" ]]; then
  echo "Error: --status must be pending, in_progress, or completed" >&2
  exit 1
fi

CURRENT_NOTES=$(jq -r '.completionNotes // ""' "$FILE")

FINAL_NOTES=""
NOTES_UPDATE=0

if [[ $NOTES_SET -eq 1 ]]; then
  if [[ -n "$CURRENT_NOTES" && $FORCE_NOTES -eq 0 ]]; then
    echo "Error: completionNotes is already non-empty on $TASK_ID — refusing to overwrite." >&2
    echo "Existing notes (${#CURRENT_NOTES} chars):" >&2
    echo "$CURRENT_NOTES" >&2
    echo >&2
    echo "Use --append-notes to add to it, or --force-notes to overwrite intentionally." >&2
    exit 1
  fi
  FINAL_NOTES="$NOTES"
  NOTES_UPDATE=1
elif [[ $APPEND_SET -eq 1 ]]; then
  ISO_NOW_SEP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  if [[ -n "$CURRENT_NOTES" ]]; then
    FINAL_NOTES="${CURRENT_NOTES}"$'\n\n'"=== appended ${ISO_NOW_SEP} ==="$'\n'"${APPEND_NOTES}"
  else
    FINAL_NOTES="$APPEND_NOTES"
  fi
  NOTES_UPDATE=1
fi

ISO_NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build update. Four cases: status+notes, status-only, notes+no-status, (unreachable: neither).
if [[ -n "$STATUS" ]]; then
  if [[ "$STATUS" == "completed" ]]; then
    if [[ $NOTES_UPDATE -eq 1 ]]; then
      jq --arg s "$STATUS" --arg t "$ISO_NOW" --arg n "$FINAL_NOTES" \
        '.status=$s | .updatedAt=$t | .completedAt=$t | .completionNotes=$n' \
        "$FILE" > "${FILE}.tmp" && mv "${FILE}.tmp" "$FILE"
    else
      jq --arg s "$STATUS" --arg t "$ISO_NOW" \
        '.status=$s | .updatedAt=$t | .completedAt=$t' \
        "$FILE" > "${FILE}.tmp" && mv "${FILE}.tmp" "$FILE"
    fi
  else
    if [[ $NOTES_UPDATE -eq 1 ]]; then
      jq --arg s "$STATUS" --arg t "$ISO_NOW" --arg n "$FINAL_NOTES" \
        '.status=$s | .updatedAt=$t | .completionNotes=$n' \
        "$FILE" > "${FILE}.tmp" && mv "${FILE}.tmp" "$FILE"
    else
      jq --arg s "$STATUS" --arg t "$ISO_NOW" \
        '.status=$s | .updatedAt=$t' \
        "$FILE" > "${FILE}.tmp" && mv "${FILE}.tmp" "$FILE"
    fi
  fi
else
  # Notes-only update, status untouched.
  jq --arg t "$ISO_NOW" --arg n "$FINAL_NOTES" \
    '.updatedAt=$t | .completionNotes=$n' \
    "$FILE" > "${FILE}.tmp" && mv "${FILE}.tmp" "$FILE"
fi

if [[ -n "$STATUS" ]]; then
  echo "Updated $TASK_ID → $STATUS"
else
  echo "Updated $TASK_ID notes (status unchanged)"
fi
