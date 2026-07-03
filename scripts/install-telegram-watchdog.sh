#!/bin/bash
# Install the telegram supervision chain as a macOS launchd agent. Jeff's ask
# (2026-07-03): if superbot2 goes down for ANY reason it must come back fully
# reachable via Telegram — and run in tmux so App Nap can't throttle it.
#
#   Install / reload:  bash scripts/install-telegram-watchdog.sh
#   Uninstall:         launchctl unload "$HOME/Library/LaunchAgents/com.superbot2.telegramwatchdog.plist"
#   Watch live:        tmux attach -t sb2-telegram
#
# Chain: launchd (KeepAlive) -> telegram-tmux-supervisor.sh -> tmux session
#        -> telegram-watchdog.sh -> telegram-watcher.mjs
#
# launchd's default PATH has neither node nor tmux — resolve at install time and
# bake the dirs into the plist PATH (same class of bug that dark-launched the
# wake-nudge; see install-orchestrator-watchdog.sh).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_DIR/scripts/telegram-tmux-supervisor.sh"
PLIST_NAME="com.superbot2.telegramwatchdog"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
SUPERBOT2_HOME="${SUPERBOT2_HOME:-$HOME/.superbot2}"
LOG_DIR="$SUPERBOT2_HOME/logs"

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then echo "node not found on PATH" >&2; exit 1; fi
TMUX_BIN="$(command -v tmux || true)"
if [[ -z "$TMUX_BIN" ]]; then echo "tmux not found on PATH" >&2; exit 1; fi

mkdir -p "$LOG_DIR"

if launchctl list "$PLIST_NAME" &>/dev/null; then
  echo "Unloading existing telegram-watchdog agent..."
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
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/telegram-tmux-supervisor.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/telegram-tmux-supervisor.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SUPERBOT2_HOME</key>
    <string>$SUPERBOT2_HOME</string>
    <key>PATH</key>
    <string>$(dirname "$NODE_BIN"):$(dirname "$TMUX_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
EOF

launchctl load "$PLIST_PATH"
echo "telegram-watchdog agent installed and loaded."
echo "  Plist:      $PLIST_PATH"
echo "  Supervisor: $SCRIPT"
echo "  Logs:       $LOG_DIR/telegram-tmux-supervisor.log (+ telegram-watcher.log)"
echo "  Watch live: tmux attach -t sb2-telegram"
echo "  Uninstall:  launchctl unload \"$PLIST_PATH\""
