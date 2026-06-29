#!/bin/bash
# Install the orchestrator active-wake nudge as a macOS launchd agent.
#
# *** DO NOT RUN THIS CASUALLY. *** This loads a watcher that can send `tmux send-keys Enter`
# into the LIVE orchestrator pane. It is intentionally NOT run by the build that created it.
# Cut it over DELIBERATELY, and only after a dry-run shakedown:
#
#   # 1. Observe-only against the live system (NEVER sends keys):
#   SUPERBOT2_HOME="$HOME/.superbot2" node scripts/orchestrator-wake-nudge.mjs --dry-run
#   #    Watch the logs across an at-capacity window; confirm it only "would nudge" on a real
#   #    stall and NEVER while a turn streams or the prompt has pending text.
#
#   # 2. Only then install (live keystrokes enabled):
#   bash scripts/install-wake-nudge.sh
#
#   # To run it observe-only as the daemon (recommended first prod step), install with:
#   WAKE_NUDGE_DRY_RUN=1 bash scripts/install-wake-nudge.sh
#
#   # Uninstall / cut it back out instantly:
#   launchctl unload "$HOME/Library/LaunchAgents/com.superbot2.wakenudge.plist"
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_DIR/scripts/orchestrator-wake-nudge.mjs"
PLIST_NAME="com.superbot2.wakenudge"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
SUPERBOT2_HOME="${SUPERBOT2_HOME:-$HOME/.superbot2}"
LOG_DIR="$SUPERBOT2_HOME/logs"
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then echo "node not found on PATH" >&2; exit 1; fi

# Optional: install in dry-run (observe-only) mode.
EXTRA_ARGS=""
if [[ "${WAKE_NUDGE_DRY_RUN:-}" == "1" ]]; then EXTRA_ARGS="--dry-run"; fi

mkdir -p "$LOG_DIR"

if launchctl list "$PLIST_NAME" &>/dev/null; then
  echo "Unloading existing wake-nudge..."
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
    <string>$NODE_BIN</string>
    <string>$SCRIPT</string>$(if [[ -n "$EXTRA_ARGS" ]]; then echo "
    <string>$EXTRA_ARGS</string>"; fi)
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/wake-nudge.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/wake-nudge.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SUPERBOT2_HOME</key>
    <string>$SUPERBOT2_HOME</string>
    <key>SUPERBOT2_NAME</key>
    <string>${SUPERBOT2_NAME:-}</string>
    <key>PATH</key>
    <string>$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
EOF

launchctl load "$PLIST_PATH"
echo "wake-nudge installed and loaded${EXTRA_ARGS:+ (DRY-RUN observe-only)}."
echo "  Plist:  $PLIST_PATH"
echo "  Script: $SCRIPT"
echo "  Logs:   $LOG_DIR/wake-nudge.log"
echo "  Uninstall: launchctl unload \"$PLIST_PATH\""
