#!/bin/bash
# superbot2 repo<->live drift check
#
# Several directories are supposed to be copies of each other, kept in sync ONLY by
# scripts/update.sh running (or by a worker hand-patching one side). Nothing else
# compares them, so a fix committed to the repo can sit un-deployed indefinitely
# while every caller keeps running the old live copy. That happened to
# scripts/update-task.sh on 2026-08-25: a destructive-bug fix was committed with 21
# green tests and was NOT in effect, because the live copy was 5 months stale.
#
# THIS SCRIPT ONLY REPORTS. It never copies a file in either direction.
#   - A DIFFERS line does NOT mean "live is stale, go overwrite it." A live file may
#     be a hand-patched hotfix the repo hasn't caught up with yet. Direction of truth
#     is NOT always repo -> live. Read both copies and knowledge/ before touching
#     anything.
#   - Do NOT "fix" drift found here by running scripts/update.sh as a reflex. That
#     script cp's every script in its list (currently ~16) from the working tree --
#     including any uncommitted changes another agent has in flight -- and restarts
#     the dashboard and agents. Correct mechanism, wrong blast radius for a one-file
#     fix. Prefer a targeted `cp` of the single file plus a diff to verify, at the
#     path callers actually execute.
#
# Exit code: 0 if every checked pair matches, 1 if anything differs or is missing on
# one side. Meant to be readable by a human (or grepped by a scheduled job) -- see
# the recommendation at the bottom of this file's header comment in the task/plan
# notes for where this should run.

set -uo pipefail

SUPERBOT2_NAME="${SUPERBOT2_NAME:-superbot2}"
REPO_DIR="${SUPERBOT2_APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
LIVE_DIR="${SUPERBOT2_HOME:-$HOME/.${SUPERBOT2_NAME}}"
UPDATE_SH="$REPO_DIR/scripts/update.sh"

STATUS=0
OK_COUNT=0
DIFF_COUNT=0
MISSING_COUNT=0

hash_raw() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'; }

# Applies the same "~/.superbot2" -> "$LIVE_DIR" substitution update.sh performs
# on skills/templates before copying, so we diff the content the live file is
# SUPPOSED to hold, not the pre-substitution repo text (which would falsely show
# every template as DIFFERS even when update.sh was run five minutes ago).
hash_normalized() {
  sed "s|~/.${SUPERBOT2_NAME}|$LIVE_DIR|g" "$1" 2>/dev/null | shasum -a 256 | awk '{print $1}'
}

report_pair() {
  local label="$1" repo_file="$2" live_file="$3" normalize="$4"
  if [[ ! -f "$repo_file" && ! -f "$live_file" ]]; then
    return
  fi
  if [[ ! -f "$repo_file" ]]; then
    printf 'MISSING (repo)  %s\n' "$label"
    MISSING_COUNT=$((MISSING_COUNT + 1)); STATUS=1
    return
  fi
  if [[ ! -f "$live_file" ]]; then
    printf 'MISSING (live)  %s\n' "$label"
    MISSING_COUNT=$((MISSING_COUNT + 1)); STATUS=1
    return
  fi
  local rh lh
  if [[ "$normalize" == "1" ]]; then
    rh=$(hash_normalized "$repo_file")
  else
    rh=$(hash_raw "$repo_file")
  fi
  lh=$(hash_raw "$live_file")
  if [[ "$rh" == "$lh" ]]; then
    printf 'IN SYNC         %s\n' "$label"
    OK_COUNT=$((OK_COUNT + 1))
  else
    printf 'DIFFERS         %s\n' "$label"
    DIFF_COUNT=$((DIFF_COUNT + 1)); STATUS=1
  fi
}

echo "=== superbot2 repo <-> live drift check ($(date -u +%Y-%m-%dT%H:%M:%SZ)) ==="
echo "REPO: $REPO_DIR"
echo "LIVE: $LIVE_DIR"
echo "REPORT ONLY -- this script never writes to either side. See header comment"
echo "before acting on a DIFFERS line; direction of truth is not always repo->live."
echo

echo "--- scripts (per the exact copy list inside scripts/update.sh) ---"
# Pulled straight out of update.sh's own for-loop rather than re-hardcoded here, so
# this detector cannot itself drift out of sync with what update.sh actually deploys
# the next time someone adds or removes a script from that list.
SCRIPT_LIST=$(grep -o 'for script in [^;]*' "$UPDATE_SH" | sed 's/for script in //')
if [[ -z "$SCRIPT_LIST" ]]; then
  echo "  WARNING: could not parse the script list out of $UPDATE_SH -- check it by hand."
  STATUS=1
else
  for script in $SCRIPT_LIST; do
    report_pair "scripts/$script" "$REPO_DIR/scripts/$script" "$LIVE_DIR/scripts/$script" 0
  done
fi

echo
echo "--- agent docs (repo agents/*.md -> live .claude/agents/*.md, direct copy) ---"
for f in "$REPO_DIR"/agents/*.md; do
  [[ -f "$f" ]] || continue
  name=$(basename "$f")
  report_pair "agents/$name" "$f" "$LIVE_DIR/.claude/agents/$name" 0
done
for f in "$LIVE_DIR"/.claude/agents/*.md; do
  [[ -f "$f" ]] || continue
  name=$(basename "$f")
  if [[ ! -f "$REPO_DIR/agents/$name" ]]; then
    printf 'MISSING (repo)  agents/%s\n' "$name"
    MISSING_COUNT=$((MISSING_COUNT + 1)); STATUS=1
  fi
done

echo
echo "--- templates (repo templates/*.md -> live templates/*.md, path-substituted) ---"
for f in "$REPO_DIR"/templates/*.md; do
  [[ -f "$f" ]] || continue
  name=$(basename "$f")
  report_pair "templates/$name" "$f" "$LIVE_DIR/templates/$name" 1
done

echo
echo "--- skills (existence only -- NOT content-checked, see note) ---"
# update.sh does a wholesale rm-rf + cp -r + sed per skill directory, which makes a
# byte/hash comparison here nontrivial (same path-substitution issue as templates,
# but recursive across every file in every skill). Out of scope for this pass --
# reporting directory-level presence only catches "a whole skill never got deployed
# / was hand-added live and never committed," which is still a real, cheap check.
for d in "$REPO_DIR"/skills/*/; do
  name=$(basename "$d")
  [[ -d "$LIVE_DIR/.claude/skills/$name" ]] || {
    printf 'MISSING (live)  skills/%s (dir)\n' "$name"
    MISSING_COUNT=$((MISSING_COUNT + 1)); STATUS=1
  }
done
for d in "$LIVE_DIR"/.claude/skills/*/; do
  name=$(basename "$d")
  if [[ ! -d "$REPO_DIR/skills/$name" ]]; then
    printf 'INFO            skills/%s exists live but not in repo (may be installed separately -- not necessarily drift)\n' "$name"
  fi
done

echo
echo "=== summary: $OK_COUNT in sync, $DIFF_COUNT differ, $MISSING_COUNT missing-on-one-side ==="
if [[ $STATUS -ne 0 ]]; then
  echo "DRIFT DETECTED. This script does not fix anything -- see header comment for why"
  echo "'just run update.sh' or 'just cp repo over live' are both wrong reflexes here."
fi

exit $STATUS
