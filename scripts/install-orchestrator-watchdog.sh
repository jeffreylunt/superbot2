#!/bin/bash
# Install the orchestrator watchdog (system-level auto-restart for superbot2) as a
# macOS launchd agent. Jeff's ask: restart superbot2 if it crashes or stops working.
#
#   Install / reload:  bash scripts/install-orchestrator-watchdog.sh
#   Uninstall:         launchctl unload "$HOME/Library/LaunchAgents/com.superbot2.orchestratorwatchdog.plist"
#
# The watchdog needs: node (health probe), tmux (relaunch into a pane), jq (health JSON).
# launchd's default PATH has NONE of these managers' dirs — resolve at install time and
# bake the dirs into the plist PATH (same class of bug that dark-launched the wake-nudge).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_DIR/scripts/orchestrator-watchdog.sh"
PLIST_NAME="com.superbot2.orchestratorwatchdog"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
SUPERBOT2_HOME="${SUPERBOT2_HOME:-$HOME/.superbot2}"
LOG_DIR="$SUPERBOT2_HOME/logs"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then echo "node not found on PATH" >&2; exit 1; fi
TMUX_BIN="$(command -v tmux || true)"
if [[ -z "$TMUX_BIN" ]]; then echo "tmux not found on PATH" >&2; exit 1; fi
JQ_BIN="$(command -v jq || true)"
if [[ -z "$JQ_BIN" ]]; then echo "jq not found on PATH" >&2; exit 1; fi

mkdir -p "$LOG_DIR"

if launchctl list "$PLIST_NAME" &>/dev/null; then
  echo "Unloading existing orchestrator-watchdog..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_NAME</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$SCRIPT</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/orchestrator-watchdog.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/orchestrator-watchdog.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SUPERBOT2_HOME</key>
    <string>$SUPERBOT2_HOME</string>
    <key>PATH</key>
    <string>$(dirname "$NODE_BIN"):$(dirname "$TMUX_BIN"):$(dirname "$JQ_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
EOF

launchctl load "$PLIST_PATH"
echo "orchestrator-watchdog installed and loaded."
echo "  Plist:  $PLIST_PATH"
echo "  Script: $SCRIPT"
echo "  Logs:   $LOG_DIR/orchestrator-watchdog.log"
echo "  Uninstall: launchctl unload \"$PLIST_PATH\""
