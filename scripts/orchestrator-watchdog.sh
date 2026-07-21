#!/bin/bash
# orchestrator-watchdog.sh — SYSTEM-LEVEL supervisor for the superbot2 orchestrator.
# Jeff's mandate (2026-07-03): "set up something at the system level to restart superbot2
# if it crashes or for any reason stops working."
#
# What it covers (the launcher's own loop only restarts claude when the .restart flag is
# set — a CRASH without the flag makes the launcher exit and superbot2 stays DOWN):
#   1. CRASH: no orchestrator claude process => relaunch `superbot2` in a tmux window
#      (tmux is required — the orchestrator is an interactive TUI and the wake-nudge
#      targets its pane). Relaunches are CAPPED (RELAUNCH_CAP per CAP_WINDOW_S) with a
#      startup grace so a boot-crash loop can't spin; hitting the cap logs CRITICAL and
#      files a blocker escalation once per window.
#   2. WEDGE: claude alive but "stopped working" — newest unread team-lead message older
#      than WEDGE_THRESHOLD_S while the transcript never advanced past it AND the prompt
#      is EMPTY (pending user text is a user state, not a wedge — never restart over it).
#      The wake-nudge fixes normal stalls in ~60s, so a backlog this old means nudging
#      failed => touch the launcher's .restart flag (graceful: launcher kills claude and
#      relaunches WITH --resume, preserving the session). If the launcher itself is dead,
#      SIGTERM the orphan claude so the crash path relaunches fresh next cycle.
#   3. COMPANIONS: restart telegram-watchdog if dead (while telegram enabled); reinstall
#      the com.superbot2.{scheduler,heartbeat,wakenudge} launchd agents if unloaded.
#
# Runs under launchd (com.superbot2.orchestratorwatchdog, KeepAlive) — see
# scripts/install-orchestrator-watchdog.sh. Uninstall = `launchctl unload` that plist.
# Env overrides (also used by test/orchestrator-watchdog.test.sh):
#   OW_CHECK_INTERVAL, OW_STARTUP_GRACE_S, OW_WEDGE_THRESHOLD_S, OW_WEDGE_COOLDOWN_S,
#   OW_RELAUNCH_CAP, OW_CAP_WINDOW_S, OW_ALIVE_CMD, OW_ALIVE_RETRIES, OW_DOWN_CONFIRM,
#   OW_LAUNCHER_ALIVE_CMD, OW_HEALTH_CMD, OW_RELAUNCH_CMD, OW_KILL_ORPHAN_CMD,
#   OW_SKIP_COMPANIONS=1, OW_SKIP_MIGRATE=1, OW_TEST_SOURCE=1 (source only)
set -u

DIR="${SUPERBOT2_HOME:-$HOME/.superbot2}"
[[ -f "$DIR/.node-path" ]] && export PATH="$(cat "$DIR/.node-path"):$PATH"
export PATH="$HOME/.local/bin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCHER="$REPO_DIR/superbot2"
LOG_DIR="$DIR/logs"
LOG_FILE="$LOG_DIR/orchestrator-watchdog.log"
PID_FILE="$DIR/orchestrator-watchdog.pid"
STATE_DIR="$DIR/.orchestrator-watchdog"
RELAUNCHES_FILE="$STATE_DIR/relaunches.txt"
WEDGE_TS_FILE="$STATE_DIR/last-wedge-restart.txt"
CAP_ALERT_FILE="$STATE_DIR/cap-alerted.txt"
RESTART_FLAG="$DIR/.restart"
LAUNCHER_PID_FILE="$DIR/.launcher.pid"
# The distinctive argv prefix of the orchestrator claude process (workers have different
# system prompts, so this cannot match them). The [O] bracket keeps the REGEX from matching
# OTHER pgrep/pkill/grep processes that carry this same pattern in their own argv — without
# it, a concurrent monitoring pgrep makes orchestrator_alive() return a false ALIVE and the
# watchdog never relaunches (observed live 2026-07-03 16:00Z during the crash test).
ORCH_PATTERN="claude --system-prompt # Superbot2 [O]rchestrator"

CHECK_INTERVAL="${OW_CHECK_INTERVAL:-30}"
ALIVE_RETRIES="${OW_ALIVE_RETRIES:-3}"
DOWN_CONFIRM="${OW_DOWN_CONFIRM:-2}"
STARTUP_GRACE_S="${OW_STARTUP_GRACE_S:-180}"
WEDGE_THRESHOLD_S="${OW_WEDGE_THRESHOLD_S:-1800}"
WEDGE_COOLDOWN_S="${OW_WEDGE_COOLDOWN_S:-3600}"
RELAUNCH_CAP="${OW_RELAUNCH_CAP:-5}"
CAP_WINDOW_S="${OW_CAP_WINDOW_S:-1800}"

mkdir -p "$LOG_DIR" "$STATE_DIR"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] orchestrator-watchdog: $1" >> "$LOG_FILE"
}

# --- liveness -----------------------------------------------------------------

# The orchestrator's argv carries the whole assembled system prompt (~300KB). macOS
# argv reads (pgrep -f / ps -o command) fail INTERMITTENTLY on argv that large —
# measured ~0.7% per probe against a healthy process, which at one probe per 30s cycle
# produced ~20 false DOWNs/day, each of which relaunched the launcher whose
# single-instance guard then MURDERED the healthy orchestrator (the entire 2026-07-03/04
# "crash loop"). So liveness is now layered, and no single argv read can declare DOWN:
#   1. argv pattern probe (authoritative when it succeeds),
#   2. name-based probe: a CHILD of the live launcher that looks like claude — by
#      comm (argv[0], "claude"; glitches at the same ~0.5% rate) OR by ucomm (true
#      p_comm from kinfo_proc — ALWAYS readable — which for claude is the versioned
#      binary basename, e.g. "2.1.201", resolved live from the install symlink),
#   3. the whole chain retried with a pause (misses are transient and bursty).
# ps+awk rather than pgrep -P/-x: macOS pgrep is also blind to any ANCESTOR of the
# caller (verified live — it hides the orchestrator from every shell descended from
# it); ps -axo always lists every pid.
claude_child_of_launcher() {
  local lpid bin
  lpid=$(cat "$LAUNCHER_PID_FILE" 2>/dev/null || true)
  [ -n "$lpid" ] || return 1
  kill -0 "$lpid" 2>/dev/null || return 1
  bin=$(basename "$(readlink "$HOME/.local/bin/claude" 2>/dev/null || true)" 2>/dev/null || true)
  ps -axo pid=,ppid=,comm=,ucomm= 2>/dev/null \
    | awk -v p="$lpid" -v b="$bin" \
        '$2 == p && ($3 == "claude" || (b != "" && $4 == b)) { found = 1; exit } END { exit !found }'
}

orchestrator_alive() {
  if [ -n "${OW_ALIVE_CMD:-}" ]; then bash -c "$OW_ALIVE_CMD" >/dev/null 2>&1; return; fi
  local i
  for ((i = 1; i <= ALIVE_RETRIES; i++)); do
    pgrep -f "$ORCH_PATTERN" >/dev/null 2>&1 && return 0
    claude_child_of_launcher && return 0
    [ "$i" -lt "$ALIVE_RETRIES" ] && sleep 2
  done
  return 1
}

launcher_alive() {
  if [ -n "${OW_LAUNCHER_ALIVE_CMD:-}" ]; then bash -c "$OW_LAUNCHER_ALIVE_CMD" >/dev/null 2>&1; return; fi
  local lpid
  lpid=$(cat "$LAUNCHER_PID_FILE" 2>/dev/null || true)
  [ -n "$lpid" ] && kill -0 "$lpid" 2>/dev/null
}

# --- relaunch cap (anti restart-loop) ------------------------------------------

relaunch_count_in_window() {
  local now cutoff
  now=$(date +%s); cutoff=$((now - CAP_WINDOW_S))
  if [ -f "$RELAUNCHES_FILE" ]; then
    awk -v c="$cutoff" '$1 >= c' "$RELAUNCHES_FILE" > "$RELAUNCHES_FILE.tmp" \
      && mv "$RELAUNCHES_FILE.tmp" "$RELAUNCHES_FILE"
    wc -l < "$RELAUNCHES_FILE" | tr -d ' '
  else
    echo 0
  fi
}

record_relaunch() { date +%s >> "$RELAUNCHES_FILE"; }

last_relaunch_ts() { tail -1 "$RELAUNCHES_FILE" 2>/dev/null || echo 0; }

alert_cap_hit_once() {
  # Alert at most once per cap window: CRITICAL log + blocker escalation (best-effort).
  local now last
  now=$(date +%s); last=$(cat "$CAP_ALERT_FILE" 2>/dev/null || echo 0)
  [ $((now - last)) -ge "$CAP_WINDOW_S" ] || return 0
  echo "$now" > "$CAP_ALERT_FILE"
  log "!!! CRITICAL: relaunch cap hit ($RELAUNCH_CAP in ${CAP_WINDOW_S}s) — orchestrator keeps dying; NOT relaunching until the window clears. Human needed."
  if [ -x "$DIR/scripts/create-escalation.sh" ] || [ -f "$DIR/scripts/create-escalation.sh" ]; then
    bash "$DIR/scripts/create-escalation.sh" blocker superbot2-app stability-upgrades \
      "Orchestrator crash-looping: watchdog relaunch cap hit" \
      --context "orchestrator-watchdog relaunched superbot2 $RELAUNCH_CAP times in ${CAP_WINDOW_S}s and it keeps dying. Supervision paused until the window clears. Check $LOG_FILE and the launcher output tmux window." \
      --priority critical >/dev/null 2>&1 || true
  fi
}

# --- relaunch -------------------------------------------------------------------

relaunch_orchestrator() {
  if [ -n "${OW_RELAUNCH_CMD:-}" ]; then bash -c "$OW_RELAUNCH_CMD" >>"$LOG_FILE" 2>&1; return; fi
  # -c "$HOME": the orchestrator MUST run with cwd=$HOME — that's the workspace claude
  # trusts (a launchd-spawned tmux window otherwise inherits cwd=/ and claude BLOCKS on an
  # interactive "trust this folder?" prompt — observed live 2026-07-03 16:02Z) and it's the
  # cwd that maps to the -Users-jeff transcript dir the wake-nudge/health checks follow.
  # Always relaunch into a DEDICATED session (default 'superbot2', override with
  # OW_TMUX_SESSION) — never "the first session that happens to exist". When the
  # orchestrator's original session died, head -1 picked sb2-telegram (the telegram
  # chain's session, observed live 2026-07-15), entangling the two supervision chains:
  # the telegram tmux supervisor treats that session as ITS OWN to kill/recreate.
  local sess="${OW_TMUX_SESSION:-superbot2}"
  if ! tmux has-session -t "=$sess" 2>/dev/null; then
    log "creating detached tmux session '$sess' running the launcher"
    tmux new-session -d -s "$sess" -c "$HOME" "exec bash '$LAUNCHER'"
  else
    log "relaunching launcher in a new window of tmux session '$sess'"
    # Trailing colon: target the SESSION (next free window index). A bare "-t $sess" is
    # parsed as window index when the session is numeric ("create window failed: index 0
    # in use" — observed live 2026-07-03 16:00Z).
    tmux new-window -d -t "${sess}:" -n superbot2 -c "$HOME" "exec bash '$LAUNCHER'"
  fi
}

handle_dead_orchestrator() {
  local now last count
  now=$(date +%s)
  last=$(last_relaunch_ts)
  if [ $((now - last)) -lt "$STARTUP_GRACE_S" ]; then
    log "orchestrator not up yet — within startup grace ($((now - last))s < ${STARTUP_GRACE_S}s), waiting"
    return 0
  fi
  count=$(relaunch_count_in_window)
  if [ "${count:-0}" -ge "$RELAUNCH_CAP" ]; then
    alert_cap_hit_once
    return 0
  fi
  log "orchestrator DOWN (no '$ORCH_PATTERN' process) — relaunching (attempt $((count + 1))/$RELAUNCH_CAP in window)"
  capture_crash_context
  record_relaunch
  relaunch_orchestrator
}

# Co-locate crash forensics with the DOWN event: the launcher's durable log now
# records claude's exit code + on-screen tail at death (see superbot2 launcher),
# so pull its last lines in here, plus the claude binary version (auto-update
# churn is a crash-cause candidate). Best-effort only.
capture_crash_context() {
  {
    echo "    claude binary: $(readlink "$HOME/.local/bin/claude" 2>/dev/null || echo unknown)"
    if [ -f "$LOG_DIR/launcher.log" ]; then
      tail -8 "$LOG_DIR/launcher.log" | sed 's/^/    launcher.log| /'
    else
      echo "    (no launcher.log yet — pre-instrumentation launcher)"
    fi
  } >> "$LOG_FILE" 2>/dev/null || true
}

# --- wedge detection --------------------------------------------------------------

health_json() {
  if [ -n "${OW_HEALTH_CMD:-}" ]; then bash -c "$OW_HEALTH_CMD" 2>/dev/null; return; fi
  node "$SCRIPT_DIR/orchestrator-wake-nudge.mjs" --health 2>/dev/null
}

kill_orphan_claude() {
  if [ -n "${OW_KILL_ORPHAN_CMD:-}" ]; then bash -c "$OW_KILL_ORPHAN_CMD" >/dev/null 2>&1; return; fi
  pkill -TERM -f "$ORCH_PATTERN" 2>/dev/null || true
}

# Auto-confirm claude's startup dialogs (folder trust / bypass-permissions consent) after a
# relaunch. They block boot while the process looks ALIVE, so without this an automated
# recovery stalls forever at the dialog (observed live 2026-07-03 16:02Z). Safe: we always
# relaunch the same $HOME workspace + repo config Jeff already trusts, and we only press
# Enter when the health probe positively identifies a known boot dialog.
accept_boot_dialog() {
  local json dialog feedback pane
  json="$1"
  dialog=$(echo "$json" | jq -r '.bootDialog' 2>/dev/null)
  feedback=$(echo "$json" | jq -r '.feedbackDialog' 2>/dev/null)
  pane=$(echo "$json" | jq -r '.paneId // empty' 2>/dev/null)
  [ -n "$pane" ] || return 1
  # Feedback/rating modal ("1: Bad ... 0: Dismiss") — press '0' to DISMISS. Enter would
  # submit a rating. Blocked the orchestrator ~25 min live 2026-07-17 until dismissed.
  if [ "$feedback" = "true" ]; then
    log "feedback/rating modal detected in pane $pane — dismissing (0)"
    if [ -n "${OW_ACCEPT_CMD:-}" ]; then bash -c "$OW_ACCEPT_CMD" >/dev/null 2>&1; else
      tmux send-keys -t "$pane" 0 2>/dev/null || true
    fi
    return 0
  fi
  [ "$dialog" = "true" ] || return 1
  log "boot dialog detected in pane $pane — auto-confirming (Enter)"
  if [ -n "${OW_ACCEPT_CMD:-}" ]; then bash -c "$OW_ACCEPT_CMD" >/dev/null 2>&1; else
    tmux send-keys -t "$pane" Enter 2>/dev/null || true
  fi
  return 0
}

# Auth death auto-repair (Jeff's chosen workaround, 2026-07-21): the orchestrator's
# config-dir OAuth token dies every few hours to a rotation race with the main token it
# was copied from. When the health probe reports loginExpired, re-copy the MAIN keychain
# credential into the orchestrator's config-dir-scoped slot and restart claude — the
# relaunch picks up the fresh token. Guards: the main credential must itself be VALID
# (else skip + loud log; the canary alerts Jeff), and a cooldown stops repair loops.
# KNOWN RISK (Jeff accepted): sharing the main refresh token; a race could someday kill
# the MAIN session's login instead — the proper fix remains a one-time /login in the
# orchestrator pane (see memory/superbot2-telegram-supervision.md).
CRED_SERVICE="${OW_CRED_SERVICE:-Claude Code-credentials-4ec282a6}"
MAIN_CRED_SERVICE="${OW_MAIN_CRED_SERVICE:-Claude Code-credentials}"
LOGIN_REPAIR_COOLDOWN_S="${OW_LOGIN_REPAIR_COOLDOWN_S:-1800}"
LOGIN_REPAIR_STAMP="$STATE_DIR/login-repair-at.txt"
repair_login_expired() {
  local json expired last now main
  json="$1"
  expired=$(echo "$json" | jq -r '.loginExpired' 2>/dev/null)
  [ "$expired" = "true" ] || return 1
  if [ -n "${OW_LOGIN_REPAIR_CMD:-}" ]; then bash -c "$OW_LOGIN_REPAIR_CMD" >/dev/null 2>&1; return 0; fi
  now=$(date +%s)
  last=$(cat "$LOGIN_REPAIR_STAMP" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$LOGIN_REPAIR_COOLDOWN_S" ]; then
    log "login expired but repair on cooldown ($((now - last))s < ${LOGIN_REPAIR_COOLDOWN_S}s) — waiting (canary will alert Jeff if this persists)"
    return 0
  fi
  main=$(security find-generic-password -s "$MAIN_CRED_SERVICE" -w 2>/dev/null || true)
  if [ -z "$main" ] || ! echo "$main" | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      try{const o=JSON.parse(d).claudeAiOauth||JSON.parse(d);process.exit(o.expiresAt>Date.now()?0:1)}catch{process.exit(1)}
    })' 2>/dev/null; then
    log "!!! login expired AND the main credential is missing/invalid — cannot auto-repair; Jeff must /login"
    echo "$now" > "$LOGIN_REPAIR_STAMP"
    return 0
  fi
  log "login expired — re-copying main credential into '$CRED_SERVICE' and restarting claude"
  security add-generic-password -U -a "$(id -un)" -s "$CRED_SERVICE" -w "$main" 2>/dev/null \
    || { log "keychain write FAILED — cannot auto-repair"; echo "$now" > "$LOGIN_REPAIR_STAMP"; return 0; }
  echo "$now" > "$LOGIN_REPAIR_STAMP"
  # Kill the logged-out claude; the existing DOWN-detection relaunch machinery brings it
  # back on the fresh token.
  pkill -TERM -f "$ORCH_PATTERN" 2>/dev/null || true
  return 0
}

check_wedge() {
  local json backlog before prompt now last
  json=$(health_json)
  [ -n "$json" ] || return 0
  # Auth death: repair before any wedge logic — a logged-out session can't be nudged.
  if repair_login_expired "$json"; then return 0; fi
  # A blocked startup dialog is neither healthy nor a wedge — confirm it and move on.
  if accept_boot_dialog "$json"; then return 0; fi
  backlog=$(echo "$json" | jq -r '.backlogAgeS // empty' 2>/dev/null)
  before=$(echo "$json" | jq -r '.transcriptBeforeBacklog' 2>/dev/null)
  prompt=$(echo "$json" | jq -r '.promptEmpty' 2>/dev/null)
  [ -n "$backlog" ] || return 0            # no backlog => healthy
  [ "$before" = "true" ] || return 0       # transcript advanced past newest msg => processing
  [ "$prompt" = "true" ] || return 0       # pending user text => user state, NEVER restart
  [ "$backlog" -gt "$WEDGE_THRESHOLD_S" ] 2>/dev/null || return 0
  now=$(date +%s); last=$(cat "$WEDGE_TS_FILE" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$WEDGE_COOLDOWN_S" ]; then
    log "wedge suspected (backlog ${backlog}s) but within wedge cooldown — holding"
    return 0
  fi
  echo "$now" > "$WEDGE_TS_FILE"
  if launcher_alive; then
    log "!!! WEDGE: backlog unprocessed for ${backlog}s with empty prompt and no turn — touching .restart (launcher restarts claude with --resume, session preserved)"
    touch "$RESTART_FLAG"
  else
    log "!!! WEDGE + launcher dead: SIGTERM orphan claude; crash path will relaunch fresh"
    kill_orphan_claude
  fi
}

# --- companions --------------------------------------------------------------------

telegram_enabled() {
  [ -f "$DIR/config.json" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.exit(c && c.telegram && c.telegram.enabled === true ? 0 : 1);
    } catch { process.exit(1); }
  ' "$DIR/config.json" 2>/dev/null
}

ensure_companions() {
  [ "${OW_SKIP_COMPANIONS:-}" = "1" ] && return 0
  # telegram-watchdog (supervises the watcher; normally dashboard-spawned)
  if telegram_enabled; then
    local tpid
    tpid=$(cat "$DIR/telegram-watchdog.pid" 2>/dev/null || true)
    if [ -z "$tpid" ] || ! kill -0 "$tpid" 2>/dev/null; then
      log "telegram-watchdog not running — starting it"
      (unset SUPERBOT2_NAME; nohup bash "$SCRIPT_DIR/telegram-watchdog.sh" >/dev/null 2>&1 &)
    fi
  fi
  # launchd agents (idempotent installers)
  local agent
  for agent in scheduler heartbeat wakenudge; do
    if ! launchctl list "com.superbot2.$agent" >/dev/null 2>&1; then
      log "launchd agent com.superbot2.$agent not loaded — reinstalling"
      case "$agent" in
        scheduler) bash "$SCRIPT_DIR/install-scheduler.sh" >>"$LOG_FILE" 2>&1 || true ;;
        heartbeat) bash "$SCRIPT_DIR/install-heartbeat.sh" >>"$LOG_FILE" 2>&1 || true ;;
        wakenudge) bash "$SCRIPT_DIR/install-wake-nudge.sh" >>"$LOG_FILE" 2>&1 || true ;;
      esac
    fi
  done
}

# --- stranded-inbox migration ---------------------------------------------------------

# Sweep unprocessed messages from dead session teams into the live session's inbox
# (see dashboard/inbox-migration.mjs). Idempotent + fail-closed (no live orchestrator =>
# no-op), so running it every supervision cycle is safe and delivers within ~CHECK_INTERVAL
# of a new session registering. OW_SKIP_MIGRATE=1 disables (tests).
run_inbox_migration() {
  [ "${OW_SKIP_MIGRATE:-}" = "1" ] && return 0
  [ -f "$SCRIPT_DIR/migrate-stranded-inbox.mjs" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  node "$SCRIPT_DIR/migrate-stranded-inbox.mjs" >>"$LOG_FILE" 2>&1 || true
}

# --- main -----------------------------------------------------------------------------

# One supervision cycle. DOWN requires DOWN_CONFIRM consecutive cycles before any
# relaunch: a real death stays down, so the only cost is CHECK_INTERVAL of extra
# recovery latency — while a transient probe glitch (the false-DOWN murder mechanism
# above) never survives two cycles ~30s apart.
DOWN_STREAK=0
supervise_cycle() {
  if orchestrator_alive; then
    DOWN_STREAK=0
    check_wedge
  else
    DOWN_STREAK=$((DOWN_STREAK + 1))
    if [ "$DOWN_STREAK" -ge "$DOWN_CONFIRM" ]; then
      handle_dead_orchestrator
    else
      log "orchestrator not detected (probe miss $DOWN_STREAK/$DOWN_CONFIRM) — confirming next cycle before relaunching"
    fi
  fi
  ensure_companions
  run_inbox_migration
}

run_main() {
  # Singleton guard (mirrors telegram-watchdog): two supervisors would double-relaunch.
  if [ -f "$PID_FILE" ]; then
    local existing
    existing="$(cat "$PID_FILE" 2>/dev/null)"
    if [ -n "$existing" ] && [ "$existing" != "$$" ] && kill -0 "$existing" 2>/dev/null; then
      log "another orchestrator-watchdog already running (pid=$existing) — exiting"
      exit 0
    fi
  fi
  echo $$ > "$PID_FILE"
  trap 'log "shutting down"; rm -f "$PID_FILE"; exit 0' SIGTERM SIGINT SIGHUP

  log "starting (pid=$$ interval=${CHECK_INTERVAL}s wedge>${WEDGE_THRESHOLD_S}s cap=${RELAUNCH_CAP}/${CAP_WINDOW_S}s confirm=${DOWN_CONFIRM} probe-retries=${ALIVE_RETRIES})"
  while true; do
    supervise_cycle
    sleep "$CHECK_INTERVAL"
  done
}

if [ "${OW_TEST_SOURCE:-}" != "1" ]; then
  run_main
fi
