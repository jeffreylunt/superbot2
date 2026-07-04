#!/bin/bash
# Tests for the superbot2 launcher's single-instance guard (see superbot2 "Single-
# instance guard (LAUNCH PATH ONLY)"). The 2026-07-03/04 crash loop was this guard
# killing a HEALTHY orchestrator on every watchdog false-DOWN relaunch — and before
# that, on ANY subcommand invocation (`superbot2 help` ran the guard too).
#
# Each case runs the real launcher against an isolated SUPERBOT2_HOME with a fake
# "old launcher" (background subshell) whose pid sits in .launcher.pid, plus a fake
# claude child (`exec -a claude sleep` — comm/argv[0] is what the guard matches).
# PATH shims neuter launchctl/lsof/npm/pgrep so the takeover case, which proceeds
# into the launch sequence, aborts at the missing prompt template without touching
# anything real (no tmux, no claude, no launchd installs).
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LAUNCHER="$SCRIPT_DIR/../superbot2"
PASS=0
FAIL=0

ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

make_home() {
  local tmp
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/bin" "$tmp/logs"
  printf '#!/bin/bash\nexit 0\n' > "$tmp/bin/launchctl"
  printf '#!/bin/bash\nexit 1\n' > "$tmp/bin/lsof"
  printf '#!/bin/bash\nexit 0\n' > "$tmp/bin/npm"
  printf '#!/bin/bash\nexit 1\n' > "$tmp/bin/pgrep"
  chmod +x "$tmp/bin/"*
  echo "$tmp"
}

# Start a fake old launcher; if $1 = with-claude, give it a claude-named child.
# Sets FAKE_PID and writes the pidfile into $HOME_DIR.
start_fake_launcher() {
  local mode="${1:-bare}"
  if [ "$mode" = "with-claude" ]; then
    ( bash -c "exec -a claude sleep 60" & sleep 60 ) &
  else
    ( sleep 60 ) &
  fi
  FAKE_PID=$!
  echo "$FAKE_PID" > "$HOME_DIR/.launcher.pid"
  sleep 1
}

cleanup_fake() {
  pkill -P "$FAKE_PID" 2>/dev/null
  kill "$FAKE_PID" 2>/dev/null
  wait "$FAKE_PID" 2>/dev/null
}

echo "launcher single-instance guard tests"

# 1. Subcommands never touch a running launcher: `superbot2 help` with a live old
# launcher pidfile => old launcher untouched, pidfile untouched, help printed.
HOME_DIR="$(make_home)"
start_fake_launcher with-claude
out=$(SUPERBOT2_HOME="$HOME_DIR" bash "$LAUNCHER" help 2>&1)
rc=$?
if [ $rc -eq 0 ] && kill -0 "$FAKE_PID" 2>/dev/null \
   && [ "$(cat "$HOME_DIR/.launcher.pid")" = "$FAKE_PID" ] \
   && echo "$out" | grep -q "Usage: superbot2"; then
  ok "subcommand (help) leaves the running launcher alone"
else
  bad "subcommand (help) leaves the running launcher alone (rc=$rc)"
fi
cleanup_fake
rm -rf "$HOME_DIR"

# 2. Launch path REFUSES takeover when the old launcher has a live claude child.
HOME_DIR="$(make_home)"
start_fake_launcher with-claude
out=$(SUPERBOT2_HOME="$HOME_DIR" PATH="$HOME_DIR/bin:$PATH" bash "$LAUNCHER" 2>&1)
rc=$?
if [ $rc -eq 1 ] && kill -0 "$FAKE_PID" 2>/dev/null \
   && [ "$(cat "$HOME_DIR/.launcher.pid")" = "$FAKE_PID" ] \
   && echo "$out" | grep -q "Refusing to replace it" \
   && grep -q "REFUSED takeover" "$HOME_DIR/logs/launcher.log"; then
  ok "launch refuses to kill a launcher with a live claude child"
else
  bad "launch refuses to kill a launcher with a live claude child (rc=$rc)"
fi
cleanup_fake
rm -rf "$HOME_DIR"

# 3. SUPERBOT2_TAKEOVER=1 forces the old kill-and-replace behavior (script then
# proceeds into the launch sequence and dies at the missing prompt template).
HOME_DIR="$(make_home)"
start_fake_launcher with-claude
out=$(SUPERBOT2_HOME="$HOME_DIR" PATH="$HOME_DIR/bin:$PATH" SUPERBOT2_TAKEOVER=1 bash "$LAUNCHER" 2>&1)
rc=$?
if ! kill -0 "$FAKE_PID" 2>/dev/null \
   && echo "$out" | grep -q "Old launcher stopped" \
   && grep -q "KILLING old launcher" "$HOME_DIR/logs/launcher.log"; then
  ok "SUPERBOT2_TAKEOVER=1 kills and replaces"
else
  bad "SUPERBOT2_TAKEOVER=1 kills and replaces (rc=$rc)"
fi
cleanup_fake
rm -rf "$HOME_DIR"

# 4. Old launcher with NO claude child (orchestrator genuinely dead) => normal
# takeover without any force flag (the watchdog-relaunch recovery path).
HOME_DIR="$(make_home)"
start_fake_launcher bare
out=$(SUPERBOT2_HOME="$HOME_DIR" PATH="$HOME_DIR/bin:$PATH" bash "$LAUNCHER" 2>&1)
rc=$?
if ! kill -0 "$FAKE_PID" 2>/dev/null \
   && echo "$out" | grep -q "Old launcher stopped"; then
  ok "dead-claude launcher is replaced without force"
else
  bad "dead-claude launcher is replaced without force (rc=$rc)"
fi
cleanup_fake
rm -rf "$HOME_DIR"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
