#!/bin/bash
# service-helper.sh — cross-platform service abstraction for superbot2's background
# agents (scheduler, heartbeat, orchestrator-watchdog, telegram-watchdog, wake-nudge).
# ONE place that knows how to install/uninstall/start/stop/status a long-running
# (keepalive) or repeating (interval) job on the host OS.
#
#   macOS  (Darwin)   -> launchd user agents   ~/Library/LaunchAgents/com.superbot2.<name>.plist
#   Linux + systemd   -> systemd --user units  ~/.config/systemd/user/superbot2-<name>.{service,timer}
#   Linux, no systemd -> setsid+nohup supervisor loop + PID file (bare WSL fallback)
#
# The macOS path emits the SAME plist keys/values and the SAME launchctl load/unload
# calls the pre-refactor installers did, so Jeff's Mac is behaviorally unchanged.
# The Linux/WSL paths are purely additive. Which Linux mechanism is used is detected
# at install time and logged.
#
# Public API — source this file, set the SVC_* spec vars, then call service_install:
#   service_install <name> <type>    type = <interval-seconds> (repeating) | keepalive
#   service_uninstall <name>
#   service_start   <name>
#   service_stop    <name>
#   service_restart <name>
#   service_status  <name>           exit 0 = running, 1 = not running
#
# Spec vars read by service_install (persisted on Linux so later start/stop/status work):
#   SVC_PROGRAM        newline-delimited argv (REQUIRED)
#                        e.g. SVC_PROGRAM=$'/bin/bash\n/path/scheduler.sh'
#   SVC_LOG            combined stdout+stderr log file (REQUIRED)
#   SVC_ENV            newline-delimited KEY=VALUE environment pairs (optional)
#   SVC_PATH           PATH string to bake into the service environment (optional)
#   SVC_PROCESS_TYPE   macOS launchd ProcessType, e.g. Interactive (optional)
#
# CLI form (so non-bash callers such as dashboard/server.js can shell out):
#   bash service-helper.sh status  <name>   -> exit code only
#   bash service-helper.sh start   <name>
#   bash service-helper.sh stop    <name>
#   bash service-helper.sh restart <name>
#
# NOTE: kept bash-3.2 safe on the shared + Darwin paths (no `declare -A`, no `mapfile`)
# because macOS ships bash 3.2. The Linux-only supervisor uses bash-4 builtins, which
# is fine — that path never runs on macOS.

SVC_HOME="${SUPERBOT2_HOME:-$HOME/.${SUPERBOT2_NAME:-superbot2}}"
SVC_RUN_DIR="$SVC_HOME/run"
# Absolute path to this file, for the supervisor re-exec (__supervise).
SVC_SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

_svc_os() {
  case "$(uname)" in
    Darwin) echo darwin ;;
    *)      echo linux ;;
  esac
}

_svc_is_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }

# Which Linux mechanism to use: systemd user units if the user manager is reachable,
# else the self-managed supervisor loop.
_svc_linux_mech() {
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    echo systemd
  else
    echo loop
  fi
}

_svc_log() { echo "service-helper: $*"; }

# ─────────────────────────── macOS / launchd ───────────────────────────

_svc_darwin_label() { echo "com.superbot2.$1"; }
_svc_darwin_plist() { echo "$HOME/Library/LaunchAgents/com.superbot2.$1.plist"; }

# Emit the plist to stdout from the SVC_* spec. Key order is irrelevant to launchd;
# the keys/values match what the individual installers wrote pre-refactor.
_svc_darwin_write_plist() {
  local type="$1"
  echo '<?xml version="1.0" encoding="UTF-8"?>'
  echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  echo '<plist version="1.0">'
  echo '<dict>'
  echo "  <key>Label</key>"
  echo "  <string>$(_svc_darwin_label "$SVC_NAME")</string>"
  echo "  <key>ProgramArguments</key>"
  echo "  <array>"
  local arg
  while IFS= read -r arg; do
    [[ -z "$arg" ]] && continue
    echo "    <string>$arg</string>"
  done <<< "$SVC_PROGRAM"
  echo "  </array>"
  if [[ "$type" == "keepalive" ]]; then
    echo "  <key>KeepAlive</key>"
    echo "  <true/>"
  else
    echo "  <key>StartInterval</key>"
    echo "  <integer>$type</integer>"
  fi
  if [[ -n "${SVC_PROCESS_TYPE:-}" ]]; then
    echo "  <key>ProcessType</key>"
    echo "  <string>$SVC_PROCESS_TYPE</string>"
  fi
  echo "  <key>StandardOutPath</key>"
  echo "  <string>$SVC_LOG</string>"
  echo "  <key>StandardErrorPath</key>"
  echo "  <string>$SVC_LOG</string>"
  echo "  <key>EnvironmentVariables</key>"
  echo "  <dict>"
  local pair k v
  while IFS= read -r pair; do
    [[ -z "$pair" ]] && continue
    k="${pair%%=*}"; v="${pair#*=}"
    echo "    <key>$k</key>"
    echo "    <string>$v</string>"
  done <<< "${SVC_ENV:-}"
  if [[ -n "${SVC_PATH:-}" ]]; then
    echo "    <key>PATH</key>"
    echo "    <string>$SVC_PATH</string>"
  fi
  echo "  </dict>"
  echo "  <key>RunAtLoad</key>"
  echo "  <true/>"
  echo '</dict>'
  echo '</plist>'
}

_svc_darwin_install() {
  local type="$1"
  local label plist
  label="$(_svc_darwin_label "$SVC_NAME")"
  plist="$(_svc_darwin_plist "$SVC_NAME")"
  mkdir -p "$HOME/Library/LaunchAgents"
  if launchctl list "$label" &>/dev/null; then
    _svc_log "unloading existing $label"
    launchctl unload "$plist" 2>/dev/null || true
  fi
  _svc_darwin_write_plist "$type" > "$plist"
  launchctl load "$plist"
  _svc_log "$SVC_NAME -> launchd agent $label"
}

_svc_darwin_uninstall() {
  local plist; plist="$(_svc_darwin_plist "$1")"
  [[ -f "$plist" ]] || { _svc_log "$1: no plist, nothing to uninstall"; return 0; }
  launchctl unload "$plist" 2>/dev/null || true
  rm -f "$plist"
  _svc_log "$1: launchd agent removed"
}

_svc_darwin_start()   { launchctl load "$(_svc_darwin_plist "$1")" 2>/dev/null || true; }
_svc_darwin_stop()    { launchctl unload "$(_svc_darwin_plist "$1")" 2>/dev/null || true; }
_svc_darwin_restart() { _svc_darwin_stop "$1"; _svc_darwin_start "$1"; }
_svc_darwin_status()  { launchctl list "$(_svc_darwin_label "$1")" &>/dev/null; }

# ─────────────────────────── Linux / systemd ───────────────────────────

_svc_unit_base() { echo "superbot2-$1"; }
_svc_unit_dir()  { echo "$HOME/.config/systemd/user"; }

# systemd >= 240 supports StandardOutput=append: (needed to keep the log-file contract).
_svc_systemd_supports_append() {
  local ver
  ver="$(systemctl --version 2>/dev/null | head -1 | grep -oE '[0-9]+' | head -1)"
  [[ -n "$ver" && "$ver" -ge 240 ]]
}

# Quote each argv token for an ExecStart= line (systemd supports "..." quoting).
_svc_systemd_execstart() {
  local out="" arg
  while IFS= read -r arg; do
    [[ -z "$arg" ]] && continue
    out+=" \"$arg\""
  done <<< "$SVC_PROGRAM"
  echo "${out# }"
}

_svc_systemd_env_lines() {
  local pair
  while IFS= read -r pair; do
    [[ -z "$pair" ]] && continue
    echo "Environment=\"$pair\""
  done <<< "${SVC_ENV:-}"
  [[ -n "${SVC_PATH:-}" ]] && echo "Environment=\"PATH=$SVC_PATH\""
}

_svc_systemd_install() {
  local type="$1"
  local base dir svc tmr exec log_lines
  base="$(_svc_unit_base "$SVC_NAME")"
  dir="$(_svc_unit_dir)"
  svc="$dir/$base.service"
  tmr="$dir/$base.timer"
  exec="$(_svc_systemd_execstart)"
  mkdir -p "$dir"

  log_lines=""
  if _svc_systemd_supports_append; then
    log_lines=$'StandardOutput=append:'"$SVC_LOG"$'\nStandardError=append:'"$SVC_LOG"
  fi

  if [[ "$type" == "keepalive" ]]; then
    {
      echo "[Unit]"
      echo "Description=superbot2 $SVC_NAME"
      echo ""
      echo "[Service]"
      echo "Type=simple"
      echo "ExecStart=$exec"
      echo "Restart=always"
      echo "RestartSec=2"
      _svc_systemd_env_lines
      [[ -n "$log_lines" ]] && echo "$log_lines"
      echo ""
      echo "[Install]"
      echo "WantedBy=default.target"
    } > "$svc"
    rm -f "$tmr"
    systemctl --user daemon-reload
    systemctl --user enable --now "$base.service" >/dev/null 2>&1 || systemctl --user restart "$base.service"
    _svc_log "$SVC_NAME -> systemd --user service $base.service (keepalive)"
  else
    # Interval job: oneshot service triggered by a timer. OnActiveSec=1s mimics
    # launchd RunAtLoad (fire ~immediately); OnUnitActiveSec repeats every N.
    {
      echo "[Unit]"
      echo "Description=superbot2 $SVC_NAME"
      echo ""
      echo "[Service]"
      echo "Type=oneshot"
      echo "ExecStart=$exec"
      _svc_systemd_env_lines
      [[ -n "$log_lines" ]] && echo "$log_lines"
    } > "$svc"
    {
      echo "[Unit]"
      echo "Description=superbot2 $SVC_NAME timer"
      echo ""
      echo "[Timer]"
      echo "OnActiveSec=1s"
      echo "OnUnitActiveSec=${type}s"
      echo "AccuracySec=1s"
      echo ""
      echo "[Install]"
      echo "WantedBy=timers.target"
    } > "$tmr"
    systemctl --user daemon-reload
    systemctl --user enable --now "$base.timer" >/dev/null 2>&1 || systemctl --user restart "$base.timer"
    _svc_log "$SVC_NAME -> systemd --user timer $base.timer (every ${type}s)"
  fi
}

# systemd control targets the timer for interval jobs, the service for keepalive.
_svc_systemd_unit() {
  local base; base="$(_svc_unit_base "$1")"
  if [[ -f "$(_svc_unit_dir)/$base.timer" ]]; then echo "$base.timer"; else echo "$base.service"; fi
}

_svc_systemd_uninstall() {
  local base dir unit
  base="$(_svc_unit_base "$1")"
  dir="$(_svc_unit_dir)"
  unit="$(_svc_systemd_unit "$1")"
  systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
  systemctl --user stop "$base.service" >/dev/null 2>&1 || true
  rm -f "$dir/$base.service" "$dir/$base.timer"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  _svc_log "$1: systemd --user unit removed"
}

_svc_systemd_start()   { systemctl --user start   "$(_svc_systemd_unit "$1")" >/dev/null 2>&1; }
_svc_systemd_stop()    { systemctl --user stop     "$(_svc_systemd_unit "$1")" >/dev/null 2>&1; }
_svc_systemd_restart() { systemctl --user restart  "$(_svc_systemd_unit "$1")" >/dev/null 2>&1; }
_svc_systemd_status()  { systemctl --user is-active "$(_svc_systemd_unit "$1")" >/dev/null 2>&1; }

# ─────────────────── Linux / supervisor loop (no systemd) ───────────────────

_svc_meta()    { echo "$SVC_RUN_DIR/service-$1.meta"; }
_svc_pidfile() { echo "$SVC_RUN_DIR/service-$1.pid"; }

# Persist the spec so start/stop/status/uninstall work in a later, separate process.
# argv + env are base64-encoded to survive newlines safely.
_svc_loop_write_meta() {
  local type="$1" gap meta
  meta="$(_svc_meta "$SVC_NAME")"
  mkdir -p "$SVC_RUN_DIR"
  if [[ "$type" == "keepalive" ]]; then gap=2; else gap="$type"; fi
  {
    echo "TYPE=$type"
    echo "GAP=$gap"
    echo "LOG=$SVC_LOG"
    echo "SVC_PATH=${SVC_PATH:-}"
    echo "PROGRAM_B64=$(printf '%s' "$SVC_PROGRAM" | base64 | tr -d '\n')"
    echo "ENV_B64=$(printf '%s' "${SVC_ENV:-}" | base64 | tr -d '\n')"
  } > "$meta"
}

# Start a process in its own session (new process group), portably. Linux has
# setsid(1); macOS does not, so fall back to perl's POSIX::setsid (mirrors scheduler.sh).
# Backgrounds the process and echoes its PID.
_svc_setsid_bg() {
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup "$@" >/dev/null 2>&1 &
  else
    /usr/bin/perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' "$@" >/dev/null 2>&1 &
  fi
  echo $!
}

_svc_loop_start() {
  local pidfile; pidfile="$(_svc_pidfile "$SVC_NAME")"
  mkdir -p "$SVC_RUN_DIR"
  # New session/group so the loop and its children survive the installer exit and can
  # be group-killed cleanly on stop.
  local pid; pid="$(_svc_setsid_bg bash "$SVC_SELF" __supervise "$SVC_NAME")"
  echo "$pid" > "$pidfile"
}

_svc_loop_install() {
  local type="$1"
  _svc_loop_stop "$SVC_NAME" >/dev/null 2>&1 || true
  _svc_loop_write_meta "$type"
  _svc_loop_start
  if [[ "$type" == "keepalive" ]]; then
    _svc_log "$SVC_NAME -> supervisor loop (keepalive, PID $(cat "$(_svc_pidfile "$SVC_NAME")"))"
  else
    _svc_log "$SVC_NAME -> supervisor loop (every ${type}s, PID $(cat "$(_svc_pidfile "$SVC_NAME")"))"
  fi
}

_svc_loop_stop() {
  local pidfile pid; pidfile="$(_svc_pidfile "$1")"
  [[ -f "$pidfile" ]] || return 0
  pid="$(cat "$pidfile" 2>/dev/null)"
  if [[ -n "$pid" ]]; then
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
}

_svc_loop_uninstall() {
  _svc_loop_stop "$1"
  rm -f "$(_svc_meta "$1")" "$(_svc_pidfile "$1")"
  _svc_log "$1: supervisor loop removed"
}

_svc_loop_restart() {
  local meta type; meta="$(_svc_meta "$1")"
  [[ -f "$meta" ]] || return 1
  # shellcheck disable=SC1090
  type="$(. "$meta"; echo "$TYPE")"
  SVC_NAME="$1"; _svc_loop_stop "$1"; _svc_loop_start
}

_svc_loop_status() {
  local pidfile pid; pidfile="$(_svc_pidfile "$1")"
  [[ -f "$pidfile" ]] || return 1
  pid="$(cat "$pidfile" 2>/dev/null)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# The supervisor body (re-exec'd via setsid). Reads meta, then loops forever:
# run the program, then sleep GAP, repeat. For interval jobs GAP is the interval;
# for keepalive GAP is a short restart backoff. Runs on Linux only.
_svc_supervise() {
  local name="$1" meta; meta="$(_svc_meta "$name")"
  [[ -f "$meta" ]] || exit 1
  # shellcheck disable=SC1090
  . "$meta"
  local log="$LOG" gap="$GAP"
  # base64 decode flag differs: GNU/Linux uses -d, BSD/macOS uses -D.
  local d="-d"; echo "" | base64 -d >/dev/null 2>&1 || d="-D"
  # Reconstruct argv into an array. `|| [[ -n "$line" ]]` keeps the final line when the
  # decoded stream has no trailing newline (base64 output does not).
  local argv=() line
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] && argv+=("$line")
  done < <(printf '%s' "$PROGRAM_B64" | base64 $d)
  # Reconstruct + export environment.
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] && export "${line?}"
  done < <(printf '%s' "$ENV_B64" | base64 $d)
  [[ -n "$SVC_PATH" ]] && export PATH="$SVC_PATH:$PATH"
  while true; do
    "${argv[@]}" >> "$log" 2>&1
    sleep "$gap"
  done
}

# ───────────────────────────── dispatch ─────────────────────────────

service_install() {
  SVC_NAME="$1"
  local type="$2"   # <seconds> | keepalive
  if [[ -z "${SVC_PROGRAM:-}" || -z "${SVC_LOG:-}" ]]; then
    echo "service_install: SVC_PROGRAM and SVC_LOG are required" >&2
    return 1
  fi
  mkdir -p "$(dirname "$SVC_LOG")"
  case "$(_svc_os)" in
    darwin) _svc_darwin_install "$type" ;;
    linux)
      case "$(_svc_linux_mech)" in
        systemd) _svc_systemd_install "$type" ;;
        loop)    _svc_loop_install "$type" ;;
      esac ;;
  esac
}

service_uninstall() {
  case "$(_svc_os)" in
    darwin) _svc_darwin_uninstall "$1" ;;
    linux)
      case "$(_svc_linux_mech)" in
        systemd) _svc_systemd_uninstall "$1" ;;
        loop)    _svc_loop_uninstall "$1" ;;
      esac ;;
  esac
}

service_start() {
  case "$(_svc_os)" in
    darwin) _svc_darwin_start "$1" ;;
    linux)
      case "$(_svc_linux_mech)" in
        systemd) _svc_systemd_start "$1" ;;
        loop)    SVC_NAME="$1"; _svc_loop_start ;;
      esac ;;
  esac
}

service_stop() {
  case "$(_svc_os)" in
    darwin) _svc_darwin_stop "$1" ;;
    linux)
      case "$(_svc_linux_mech)" in
        systemd) _svc_systemd_stop "$1" ;;
        loop)    _svc_loop_stop "$1" ;;
      esac ;;
  esac
}

service_restart() {
  case "$(_svc_os)" in
    darwin) _svc_darwin_restart "$1" ;;
    linux)
      case "$(_svc_linux_mech)" in
        systemd) _svc_systemd_restart "$1" ;;
        loop)    _svc_loop_restart "$1" ;;
      esac ;;
  esac
}

service_status() {
  case "$(_svc_os)" in
    darwin) _svc_darwin_status "$1" ;;
    linux)
      case "$(_svc_linux_mech)" in
        systemd) _svc_systemd_status "$1" ;;
        loop)    _svc_loop_status "$1" ;;
      esac ;;
  esac
}

# CLI entrypoint: only runs when executed directly (not when sourced), so callers
# such as dashboard/server.js can do `bash service-helper.sh status scheduler`.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  verb="${1:-}"; shift || true
  case "$verb" in
    __supervise)     _svc_supervise "$@" ;;
    status)          service_status "$@" ;;
    start)           service_start "$@" ;;
    stop)            service_stop "$@" ;;
    restart)         service_restart "$@" ;;
    uninstall)       service_uninstall "$@" ;;
    *) echo "usage: service-helper.sh {status|start|stop|restart|uninstall} <name>" >&2; exit 2 ;;
  esac
fi
