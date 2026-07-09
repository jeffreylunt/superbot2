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

# Max-runtime self-guard. The singleton guard above means ONE wedged tick darks the
# WHOLE scheduler: every later 60s launchd fire sees the stale PID still alive and
# exits, so a single hung synchronous op (a wedged node/jq/fs call, or any future
# network call added without a timeout) silently suppresses ALL scheduled jobs until
# it finally dies — the multi-hour-blackout signature (7/2). Bound every tick to < the
# 60s StartInterval so a wedge self-terminates and the very next fire recovers.
# Dispatched script jobs run in their OWN session (perl setsid, below) — not in this
# process, so the guard never cuts short a legitimately long-running job.
MAIN_PID=$$
WATCHDOG_PID=""
_cleanup() { [[ -n "$WATCHDOG_PID" ]] && kill "$WATCHDOG_PID" 2>/dev/null; rm -f "$PID_FILE" "${SCHEDULE:-}"; }
trap _cleanup EXIT
mkdir -p "$DIR/logs"
SELF_GUARD_SECS="${SCHEDULER_MAX_TICK_SECS:-55}"
(
  sleep "$SELF_GUARD_SECS"
  echo "$(date '+%Y-%m-%d %H:%M') - SELF-GUARD: tick (PID $MAIN_PID) exceeded ${SELF_GUARD_SECS}s — killing wedged tick so the next fire recovers" >> "$DIR/logs/scheduler.log"
  kill -TERM "$MAIN_PID" 2>/dev/null
  sleep 3
  kill -KILL "$MAIN_PID" 2>/dev/null
) &
WATCHDOG_PID=$!
# Disown so _cleanup's kill of the still-sleeping watchdog on a NORMAL tick doesn't emit
# a bash job-control "Terminated" line to the log every 60s (kill-by-PID still reaps it).
disown "$WATCHDOG_PID" 2>/dev/null || true

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
resolve_team_dir() {
  node -e "
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
" "$TEAMS_DIR" "$SUPERBOT2_NAME"
}
TEAM_DIR=$(resolve_team_dir)

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

const nowMinutes = parseInt(nowHour, 10) * 60 + parseInt(nowMin, 10);

// All non-time guards (day-of-week / one-shot date / day-of-month / month) are
// evaluated against TODAY. Catch-up is scoped to the current calendar day, so a
// missed occurrence and the current tick share the same date — the same guards apply.
//
// KNOWN BOUND — midnight crossing: catch-up only back-fills TODAY's slots. A slot
// missed on the far side of midnight (e.g. a 23:50 job while the scheduler was down
// overnight, recovering at 00:10) is NOT back-filled: its last-run key is keyed to
// yesterday's date, which no later tick revisits. This is deliberate — it bounds
// catch-up and avoids re-evaluating yesterday's day-of-week/date guards. The real
// incident class (a multi-hour DAYTIME blackout, e.g. 7/2 08:00–16:30) is fully
// covered; overnight cross-midnight misses are the accepted residual gap.
function guardsPass(job) {
  if (job.days && job.days.length > 0 && !job.days.includes(nowDay)) return false;
  if (job.date && job.date !== nowDate) return false; // one-shot fires only on its date
  if (job.dayOfMonth != null) {
    const dom = Array.isArray(job.dayOfMonth) ? job.dayOfMonth : [job.dayOfMonth];
    if (!dom.map(Number).includes(nowDom)) return false;
  }
  if (job.months != null) {
    const mm = Array.isArray(job.months) ? job.months : [job.months];
    if (!mm.map(Number).includes(nowMonth)) return false;
  }
  return true;
}

const due = [];
for (const job of schedule) {
  if (!guardsPass(job)) continue;
  // Support both time (string) and times (string[])
  const jobTimes = job.times || (job.time ? [job.time] : []);

  // Collect every scheduled occurrence for TODAY that is due-now-or-overdue and not
  // yet fired. This is the catch-up sweep: if the scheduler was dark when a slot's
  // exact minute passed, that slot is still <= now and unmarked, so we pick it up here
  // instead of losing it (the old code only matched jobH===now && jobM===now).
  let latest = null;          // most-recent overdue slot — the one we actually dispatch
  const missedKeys = [];      // every overdue-unfired slot — all marked, to coalesce
  for (const t of jobTimes) {
    const [jobH, jobM] = t.split(':');
    const slotMinutes = parseInt(jobH, 10) * 60 + parseInt(jobM, 10);
    if (Number.isNaN(slotMinutes)) continue;
    if (slotMinutes > nowMinutes) continue;          // still in the future today — leave it
    const key = job.name + ':' + nowDate + 'T' + t;
    if (lastRun[key] === key) continue;              // already fired — dedup
    missedKeys.push(key);
    if (!latest || slotMinutes > latest.minutes) latest = { t, minutes: slotMinutes };
  }
  if (!latest) continue;

  // Coalesce: mark ALL overdue slots fired (so a job that missed many fires — e.g. a
  // 30-min sweep down 8h — never re-fires the backlog 16x), but dispatch only the
  // single most-recent slot. A slot firing later than its scheduled minute is a catch-up.
  for (const key of missedKeys) lastRun[key] = key;
  due.push({ ...job, time: latest.t, _catchUp: latest.minutes < nowMinutes });
}
// Persist last-run BEFORE the due array is emitted (bash dispatches only after node
// returns), so every slot is durably marked before its first dispatch — a crash or a
// self-guard kill mid-dispatch can never double-fire a caught-up slot. Write atomically
// (tmp + rename) so a kill landing mid-write can't leave a truncated/corrupt tracker.
const lrPath = process.argv[2];
fs.writeFileSync(lrPath + '.tmp', JSON.stringify(lastRun, null, 2));
fs.renameSync(lrPath + '.tmp', lrPath);
if (due.length > 0) console.log(JSON.stringify(due));
" "$SCHEDULE" "$LAST_RUN" "$NOW_HOUR" "$NOW_MIN" "$NOW_DAY" "$NOW_DATE" "$NOW_DOM" "$NOW_MONTH" 2>> "$LOG")

# ── Lossless delivery ──────────────────────────────────────────────────────────
# The team dir resolved at script start can be DELETED mid-run: session rotation
# replaces team dirs, and on 2026-07-04 09:00 MT three scheduled_job messages died
# against the vanished session-7d562e09 ("No such file or directory" at the inbox
# redirect) — silently lost, because lastRun was already marked so they never
# re-fired. Delivery now (a) re-resolves the active team AT WRITE TIME per message,
# (b) falls back to recreating the start-of-run team dir (the stranded-inbox
# migration sweeps it to the live team within ~30s), and (c) dead-letters anything
# that still can't be written, redelivered automatically on later scheduler runs.
DEAD_LETTER="$DIR/scheduler-dead-letter.jsonl"

# deliver_to_inbox MSG_JSON -> prints the inbox path written on success, rc=1 on failure
deliver_to_inbox() {
  local msg="$1" team_dir inbox
  team_dir=$(resolve_team_dir 2>/dev/null || true)
  [[ -z "$team_dir" || ! -d "$team_dir" ]] && team_dir="$TEAM_DIR"
  inbox="$team_dir/inboxes/team-lead.json"
  mkdir -p "$team_dir/inboxes" 2>/dev/null || true
  if [[ -f "$inbox" ]] && jq -e '. | type == "array"' "$inbox" >/dev/null 2>&1; then
    if locked_write "$inbox" '. + [$msg]' --argjson msg "$msg"; then
      echo "$inbox"; return 0
    fi
  elif echo "[$msg]" > "$inbox" 2>/dev/null; then
    echo "$inbox"; return 0
  fi
  return 1
}

# Redeliver anything a previous run dead-lettered (runs even when no job is due now).
if [[ -s "$DEAD_LETTER" ]]; then
  DL_REMAINING=$(mktemp)
  while IFS= read -r DL_MSG; do
    [[ -z "$DL_MSG" ]] && continue
    if DL_INBOX=$(deliver_to_inbox "$DL_MSG"); then
      echo "$(date '+%Y-%m-%d %H:%M') - Redelivered dead-lettered message → $DL_INBOX" >> "$LOG"
    else
      echo "$DL_MSG" >> "$DL_REMAINING"
    fi
  done < "$DEAD_LETTER"
  if [[ -s "$DL_REMAINING" ]]; then
    mv "$DL_REMAINING" "$DEAD_LETTER"
  else
    rm -f "$DL_REMAINING" "$DEAD_LETTER"
  fi
fi

[[ -z "$RESULT" ]] && exit 0

# Drop each due job as a notification in team-lead's inbox
echo "$RESULT" | jq -c '.[]' | while read -r JOB; do
  JOB_NAME=$(echo "$JOB" | jq -r '.name')
  JOB_TASK=$(echo "$JOB" | jq -r '.task')
  JOB_TIME=$(echo "$JOB" | jq -r '.time')

  # Extract optional fields from job config for metadata
  JOB_SPACE=$(echo "$JOB" | jq -r '.space // empty')
  JOB_DAYS=$(echo "$JOB" | jq -c '.days // []')

  # Slots fired later than their scheduled minute (scheduler was dark) are caught up.
  CATCHUP_TAG=""
  [[ "$(echo "$JOB" | jq -r '._catchUp // false')" == "true" ]] && CATCHUP_TAG=" (catch-up)"

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

    if TARGET_INBOX=$(deliver_to_inbox "$MSG"); then
      echo "$(date '+%Y-%m-%d %H:%M') - Scheduled: $JOB_NAME$CATCHUP_TAG → $TARGET_INBOX" >> "$LOG"
    else
      echo "$MSG" | jq -c '.' >> "$DEAD_LETTER" 2>/dev/null || echo "$MSG" >> "$DEAD_LETTER"
      echo "$(date '+%Y-%m-%d %H:%M') - DELIVERY FAILED for $JOB_NAME — dead-lettered to $DEAD_LETTER (will retry next run)" >> "$LOG"
    fi
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
      echo "$(date '+%Y-%m-%d %H:%M') - Executing script for $JOB_NAME$CATCHUP_TAG: $RESOLVED_SCRIPT" >> "$LOG"
      # Spawn in a NEW SESSION, not a plain background subshell. Under launchd a
      # backgrounded child shares this script's process group, and launchd SIGKILLs
      # that whole group the moment this script exits (AbandonProcessGroup defaults
      # to false) — the child died mid-run before its work completed (every
      # jedd-sweep dispatch was silently killed 2026-06-29→07-04 while this log
      # still said "Executing"). macOS ships no setsid(1); perl's POSIX::setsid is
      # the portable equivalent. The sleep keeps this script alive past the child's
      # setsid() call so the group-kill can never land in the fork→setsid window.
      /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' /bin/bash "$RESOLVED_SCRIPT" </dev/null >> "$LOG" 2>&1 &
      sleep 1
    fi
  fi
done
