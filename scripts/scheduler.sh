#!/bin/bash
# Load node path resolved at install time (works across all node managers)
DIR="${SUPERBOT2_HOME:-$HOME/.superbot2}"
[[ -f "$DIR/.node-path" ]] && export PATH="$(cat "$DIR/.node-path"):$PATH"
export PATH="$HOME/.local/bin:$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Singleton guard — skip if a previous scheduler run is still in progress
PID_FILE="$DIR/.pids/scheduler.pid"
mkdir -p "$(dirname "$PID_FILE")"
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
  if [[ "$OLD_PID" =~ ^[0-9]+$ ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "scheduler: previous run still in progress (PID $OLD_PID), skipping"
    exit 0
  fi
  rm -f "$PID_FILE"
fi
echo $$ > "$PID_FILE.$$"
mv "$PID_FILE.$$" "$PID_FILE"
_cleanup() { rm -f "$PID_FILE" "${SCHEDULE:-}"; }
trap _cleanup EXIT

# Source file locking helper
source "$SCRIPT_DIR/lock-helper.sh"
SUPERBOT2_NAME="${SUPERBOT2_NAME:-superbot2}"
CLAUDE_DIR="$DIR/.claude"
CONFIG="$DIR/config.json"
LAST_RUN="$DIR/schedule-last-run.json"
LOG="$DIR/logs/scheduler.log"
TEAMS_DIR="$CLAUDE_DIR/teams"

# Exit silently if no global config
[[ ! -f "$CONFIG" ]] && exit 0

# Resolve the ACTIVE orchestrator team dir. With TeamCreate unavailable in the current
# harness, each orchestrator session registers under a session-based team name (e.g.
# 'session-475577c1') instead of the fixed 'superbot2'. Hardcoding teams/superbot2 sends
# scheduled_job messages to a dead inbox the live orchestrator never reads (silent outage)
# — and the fixed 'superbot2' dir often has no config.json, so the old gate exited here
# every run. Mirror dashboard/active-team-inbox.mjs: among teams with a REAL config.json,
# pick the one whose activity (config.json / inbox files) is freshest. An explicit
# SUPERBOT2_NAME other than the legacy 'superbot2' default forces that team.
TEAM_DIR=$(node -e "
const fs = require('fs'), path = require('path');
const teamsDir = process.argv[1], pinned = process.argv[2];
function realMtime(p) { try { const st = fs.lstatSync(p); if (st.isSymbolicLink() || !st.isFile()) return null; return st.mtimeMs; } catch { return null; } }
if (pinned && pinned !== 'superbot2') { process.stdout.write(path.join(teamsDir, pinned)); process.exit(0); }
let teams = [];
try { teams = fs.readdirSync(teamsDir); } catch { process.exit(0); }
let best = null;
for (const t of teams) {
  const dir = path.join(teamsDir, t);
  const cfg = realMtime(path.join(dir, 'config.json'));
  if (cfg === null) continue; // not a live/registered orchestrator team
  const dash = realMtime(path.join(dir, 'inboxes', 'dashboard-user.json')) ?? 0;
  const lead = realMtime(path.join(dir, 'inboxes', 'team-lead.json')) ?? 0;
  const score = Math.max(cfg, dash, lead);
  if (!best || score > best.score) best = { dir, score };
}
if (best) process.stdout.write(best.dir);
" "$TEAMS_DIR" "$SUPERBOT2_NAME")

# Exit silently if no live orchestrator team was found
[[ -z "$TEAM_DIR" || ! -f "$TEAM_DIR/config.json" ]] && exit 0

# Ensure log directory exists
mkdir -p "$DIR/logs"

# Extract schedule array from config.json + space schedule.json files
SCHEDULE=$(mktemp)
node -e "
const fs = require('fs'), path = require('path');
const config = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const globalJobs = (config.schedule || []);
const spacesDir = path.join(process.argv[2], 'spaces');
let spaceJobs = [];
if (fs.existsSync(spacesDir)) {
  for (const slug of fs.readdirSync(spacesDir)) {
    const schedFile = path.join(spacesDir, slug, 'schedule.json');
    if (!fs.existsSync(schedFile)) continue;
    try {
      const entries = JSON.parse(fs.readFileSync(schedFile, 'utf8'));
      if (Array.isArray(entries)) {
        for (const j of entries) {
          // Skip skill-declared schedules (handled by skill system)
          if (j.name && j.name.startsWith('skill:')) continue;
          if (!j.space) j.space = slug;
          spaceJobs.push(j);
        }
      }
    } catch {}
  }
}
const all = [...globalJobs, ...spaceJobs];
console.log(JSON.stringify(all));
" "$CONFIG" "$DIR" > "$SCHEDULE"

SCHEDULE_DATA=$(cat "$SCHEDULE")
[[ "$SCHEDULE_DATA" == "[]" ]] && { rm -f "$SCHEDULE"; exit 0; }

# Ensure last-run tracker exists
[[ ! -f "$LAST_RUN" ]] && echo '{}' > "$LAST_RUN"

NOW_HOUR=$(date '+%H')
NOW_MIN=$(date '+%M')
NOW_DAY=$(date '+%a' | tr '[:upper:]' '[:lower:]')
NOW_DATE=$(date '+%Y-%m-%d')
NOW_DOM=$(date '+%d' | sed 's/^0//')  # day of month, no leading zero (1..31)
NOW_MONTH=$(date '+%m' | sed 's/^0//')  # month, no leading zero (1..12)

# Find due jobs, update last-run tracker, output JSON array of due jobs
RESULT=$(node -e "
const fs = require('fs');
const schedule = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const lastRun = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const [nowHour, nowMin, nowDay, nowDate, nowDom, nowMonth] = [process.argv[3], process.argv[4], process.argv[5], process.argv[6], parseInt(process.argv[7], 10), parseInt(process.argv[8], 10)];

// Migrate old-format lastRun keys (keyed by job.name) to new format (keyed by composite key)
for (const job of schedule) {
  const oldVal = lastRun[job.name];
  if (oldVal && oldVal.includes(':' + nowDate + 'T')) {
    const oldTime = oldVal.split('T').pop();
    if (oldTime) lastRun[job.name + ':' + nowDate + 'T' + oldTime] = oldVal;
    delete lastRun[job.name];
  }
}

const due = [];
for (const job of schedule) {
  // Support both time (string) and times (string[])
  const jobTimes = job.times || (job.time ? [job.time] : []);
  for (const t of jobTimes) {
    const [jobH, jobM] = t.split(':');
    if (jobH !== nowHour || jobM !== nowMin) continue;
    if (job.days && job.days.length > 0 && !job.days.includes(nowDay)) continue;
    // One-shot date guard: if 'date' is set, only fire on that exact YYYY-MM-DD
    if (job.date && job.date !== nowDate) continue;
    // Day-of-month guard: integer (1..31) or array of ints
    if (job.dayOfMonth != null) {
      const dom = Array.isArray(job.dayOfMonth) ? job.dayOfMonth : [job.dayOfMonth];
      if (!dom.map(Number).includes(nowDom)) continue;
    }
    // Months-of-year guard: integer (1..12) or array of ints (e.g. [2,5,8,11] for quarterly)
    if (job.months != null) {
      const mm = Array.isArray(job.months) ? job.months : [job.months];
      if (!mm.map(Number).includes(nowMonth)) continue;
    }
    const key = job.name + ':' + nowDate + 'T' + t;
    if (lastRun[key] === key) continue;
    lastRun[key] = key;
    // Include the matched time in the output for the inbox message
    due.push({ ...job, time: t });
    break; // only fire once per job per minute
  }
}
fs.writeFileSync(process.argv[2], JSON.stringify(lastRun, null, 2));
if (due.length > 0) console.log(JSON.stringify(due));
" "$SCHEDULE" "$LAST_RUN" "$NOW_HOUR" "$NOW_MIN" "$NOW_DAY" "$NOW_DATE" "$NOW_DOM" "$NOW_MONTH" 2>> "$LOG")

[[ -z "$RESULT" ]] && exit 0

# Drop each due job as a notification in team-lead's inbox
INBOX="$TEAM_DIR/inboxes/team-lead.json"

echo "$RESULT" | jq -c '.[]' | while read -r JOB; do
  JOB_NAME=$(echo "$JOB" | jq -r '.name')
  JOB_TASK=$(echo "$JOB" | jq -r '.task')
  JOB_TIME=$(echo "$JOB" | jq -r '.time')

  # Extract optional fields from job config for metadata
  JOB_SPACE=$(echo "$JOB" | jq -r '.space // empty')
  JOB_DAYS=$(echo "$JOB" | jq -c '.days // []')

  # Only post an inbox note if the job has a real task. Script-only jobs
  # (script field set, task empty/absent) run silently — they self-report via
  # their own logs, so they must not spam team-lead 48x/day.
  if [[ -n "$JOB_TASK" && "$JOB_TASK" != "null" ]]; then
    MSG=$(jq -n \
      --arg from "scheduler" \
      --arg type "scheduled_job" \
      --arg text "Scheduled job **$JOB_NAME** is due (${JOB_TIME}):\n\n$JOB_TASK" \
      --arg summary "Scheduled: $JOB_NAME" \
      --arg jobName "$JOB_NAME" \
      --arg jobTime "$JOB_TIME" \
      --arg jobSpace "$JOB_SPACE" \
      --argjson jobDays "$JOB_DAYS" \
      --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{from: $from, type: $type, text: $text, summary: $summary, metadata: {jobName: $jobName, scheduledTime: $jobTime, space: (if $jobSpace != "" then $jobSpace else null end), days: $jobDays}, timestamp: $ts, read: false}')

    if [[ -f "$INBOX" ]] && jq -e '. | type == "array"' "$INBOX" >/dev/null 2>&1; then
      locked_write "$INBOX" '. + [$msg]' --argjson msg "$MSG"
    else
      echo "[$MSG]" > "$INBOX"
    fi

    echo "$(date '+%Y-%m-%d %H:%M') - Scheduled: $JOB_NAME → team-lead inbox" >> "$LOG"
  fi

  # Execute script if job has a "script" field (runs outside Claude Code, so claude -p works)
  JOB_SCRIPT=$(echo "$JOB" | jq -r '.script // empty')
  if [[ -n "$JOB_SCRIPT" ]]; then
    # Validate script path: must be non-empty, resolve within SUPERBOT2_HOME, and exist.
    # pwd -P: canonicalize (resolve symlinks) so the containment check compares like with
    # like — realpath() below returns the canonical path, and on macOS $TMPDIR/other dirs
    # are often symlinks (/var -> /private/var), which made valid scripts look like escapes.
    ALLOWED_BASE="$(cd "$DIR" && pwd -P)"
    # Portable resolution: GNU `realpath -m` (Linux) resolves non-existent paths; BSD/macOS
    # `realpath` lacks -m but resolves EXISTING files fine (the script must exist anyway). Try GNU
    # first, fall back to BSD — backward-compatible, and existing task-based jobs never hit this path.
    RESOLVED_SCRIPT="$(cd "$DIR" && { realpath -m "$JOB_SCRIPT" 2>/dev/null || realpath "$JOB_SCRIPT" 2>/dev/null; } || echo "")"
    if [[ -z "$RESOLVED_SCRIPT" ]]; then
      echo "$(date '+%Y-%m-%d %H:%M') - REJECTED script for $JOB_NAME: could not resolve path" >> "$LOG"
    elif [[ "$RESOLVED_SCRIPT" != "$ALLOWED_BASE"/* ]]; then
      echo "$(date '+%Y-%m-%d %H:%M') - REJECTED script for $JOB_NAME: path escapes $ALLOWED_BASE ($RESOLVED_SCRIPT)" >> "$LOG"
    elif [[ ! -f "$RESOLVED_SCRIPT" ]]; then
      echo "$(date '+%Y-%m-%d %H:%M') - REJECTED script for $JOB_NAME: file not found ($RESOLVED_SCRIPT)" >> "$LOG"
    else
      echo "$(date '+%Y-%m-%d %H:%M') - Executing script for $JOB_NAME: $RESOLVED_SCRIPT" >> "$LOG"
      (bash "$RESOLVED_SCRIPT" >> "$LOG" 2>&1 &)
    fi
  fi
done
