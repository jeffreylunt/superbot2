#!/bin/bash
# Tests for scripts/service-helper.sh — the cross-platform service abstraction that
# replaced the direct launchd/launchctl installers (WSL/Linux port). Runs on macOS and
# Linux: the Linux branches are exercised via a fake `uname`/`systemctl` PATH shim, so
# they are covered regardless of the host OS. NEVER loads a real launchd/systemd unit.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER="$DIR/../scripts/service-helper.sh"
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

echo "service-helper cross-platform tests"

# 1. Darwin plist generation is a pure text function — assert its shape on any OS.
(
  export SUPERBOT2_HOME="$(mktemp -d)"
  source "$HELPER"
  SVC_NAME=scheduler
  SVC_PROGRAM=$'/bin/bash\n/path/scheduler.sh'
  SVC_LOG="/x/scheduler.log"
  SVC_ENV=$'SUPERBOT2_HOME=/x\nSUPERBOT2_NAME=superbot2'
  o="$(_svc_darwin_write_plist 60)"
  echo "$o" | grep -q "<string>com.superbot2.scheduler</string>" &&
  echo "$o" | grep -q "<key>StartInterval</key>" &&
  echo "$o" | grep -q "<integer>60</integer>" &&
  echo "$o" | grep -q "<key>RunAtLoad</key>" &&
  echo "$o" | grep -q "<string>/path/scheduler.sh</string>"
) && ok "darwin: interval plist has label/StartInterval/RunAtLoad/args" \
  || bad "darwin: interval plist shape"

(
  export SUPERBOT2_HOME="$(mktemp -d)"
  source "$HELPER"
  SVC_NAME=telegramwatchdog
  SVC_PROGRAM=$'/bin/bash\n/tg.sh'
  SVC_LOG="/x/tg.log"; SVC_PATH="/opt/node/bin:/usr/bin"; SVC_PROCESS_TYPE="Interactive"
  o="$(_svc_darwin_write_plist keepalive)"
  echo "$o" | grep -q "<key>KeepAlive</key>" &&
  echo "$o" | grep -q "<string>Interactive</string>" &&
  echo "$o" | grep -q "<string>/opt/node/bin:/usr/bin</string>" &&
  ! echo "$o" | grep -q "<key>StartInterval</key>"
) && ok "darwin: keepalive plist has KeepAlive/ProcessType/PATH, no StartInterval" \
  || bad "darwin: keepalive plist shape"

# 2. Linux systemd path (fake uname + systemctl reachable).
SHIM="$(mktemp -d)"
printf '#!/bin/bash\necho Linux\n' > "$SHIM/uname"
cat > "$SHIM/systemctl" <<'EOF'
#!/bin/bash
[[ "$1 $2" == "--user show-environment" ]] && exit 0
[[ "$1" == "--version" ]] && { echo "systemd 249 (249)"; exit 0; }
echo "systemctl $*" >> "$SYSCTL_LOG"; exit 0
EOF
chmod +x "$SHIM/uname" "$SHIM/systemctl"
LH="$(mktemp -d)"
(
  export PATH="$SHIM:$PATH" HOME="$LH" SUPERBOT2_HOME="$LH/.superbot2" SYSCTL_LOG="$LH/sc.log"
  source "$HELPER"
  SVC_PROGRAM=$'/bin/bash\n/repo/scheduler.sh'; SVC_LOG="$SUPERBOT2_HOME/logs/s.log"
  SVC_ENV=$'SUPERBOT2_NAME=superbot2'
  service_install scheduler 60 >/dev/null
  SVC_PROGRAM=$'/bin/bash\n/repo/ow.sh'; SVC_LOG="$SUPERBOT2_HOME/logs/ow.log"
  SVC_ENV=""; SVC_PATH="/opt/node/bin:/usr/bin"
  service_install orchestratorwatchdog keepalive >/dev/null
)
U="$LH/.config/systemd/user"
{ grep -q "OnUnitActiveSec=60s" "$U/superbot2-scheduler.timer" &&
  grep -q "OnActiveSec=1s"     "$U/superbot2-scheduler.timer" &&
  grep -q "Type=oneshot"       "$U/superbot2-scheduler.service" &&
  grep -q 'ExecStart="/bin/bash" "/repo/scheduler.sh"' "$U/superbot2-scheduler.service"; } \
  && ok "systemd: interval -> oneshot service + 60s timer" || bad "systemd: interval unit"
{ grep -q "Type=simple"    "$U/superbot2-orchestratorwatchdog.service" &&
  grep -q "Restart=always" "$U/superbot2-orchestratorwatchdog.service" &&
  grep -q 'Environment="PATH=/opt/node/bin:/usr/bin"' "$U/superbot2-orchestratorwatchdog.service" &&
  [[ ! -f "$U/superbot2-orchestratorwatchdog.timer" ]]; } \
  && ok "systemd: keepalive -> Restart=always service, no timer" || bad "systemd: keepalive unit"
grep -q "enable --now superbot2-scheduler.timer" "$LH/sc.log" \
  && ok "systemd: enable --now the timer" || bad "systemd: enable --now"

# 3. Linux supervisor-loop path (fake uname, systemctl absent).
SHIM2="$(mktemp -d)"
printf '#!/bin/bash\necho Linux\n' > "$SHIM2/uname"; chmod +x "$SHIM2/uname"
LH2="$(mktemp -d)"; OUT="$LH2/ticks.txt"
INST="$LH2/install.sh"
cat > "$INST" <<EOF
source "$HELPER"
[[ "\$(_svc_linux_mech)" == "loop" ]] || exit 3
SVC_PROGRAM=\$'/bin/bash\n-c\necho tick >> $OUT'
SVC_LOG="\$SUPERBOT2_HOME/logs/beat.log"
service_install heartbeat 1 >/dev/null
EOF
env PATH="$SHIM2:/usr/bin:/bin" HOME="$LH2" SUPERBOT2_HOME="$LH2/.superbot2" bash "$INST"
run() { env PATH="$SHIM2:/usr/bin:/bin" HOME="$LH2" SUPERBOT2_HOME="$LH2/.superbot2" bash "$HELPER" "$@"; }
sleep 3
run status heartbeat && ok "loop: status reports running" || bad "loop: status running"
n=$(wc -l < "$OUT" 2>/dev/null | tr -d ' '); [[ "${n:-0}" -ge 2 ]] && ok "loop: job fired repeatedly (n=$n)" || bad "loop: job repeat (n=${n:-0})"
run stop heartbeat; sleep 1
run status heartbeat && bad "loop: still running after stop" || ok "loop: stop halts supervisor"
run uninstall heartbeat
[[ ! -f "$LH2/.superbot2/run/service-heartbeat.meta" ]] && ok "loop: uninstall removes meta" || bad "loop: uninstall meta"

pkill -f "$HELPER __supervise" 2>/dev/null
rm -rf "$SHIM" "$SHIM2" "$LH" "$LH2"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
