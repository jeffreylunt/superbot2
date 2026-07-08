# Running superbot2 on WSL / Linux

superbot2's background jobs (scheduler, heartbeat, watchdogs, wake-nudge) were originally
installed as **macOS launchd agents** via `launchctl`. `launchctl`/launchd do not exist on
Linux/WSL, so a WSL install used to fail with *"launchctl: command not found"*.

All of those jobs now go through one cross-platform abstraction —
[`scripts/service-helper.sh`](../scripts/service-helper.sh) — which picks the right host
mechanism automatically. **macOS behavior is unchanged.**

## The service abstraction

`scripts/service-helper.sh` exposes:

| function | purpose |
|---|---|
| `service_install <name> <type>` | install + start. `type` = `<interval-seconds>` (repeating) or `keepalive` (long-running, auto-restart) |
| `service_uninstall <name>` | stop + remove |
| `service_start/stop/restart <name>` | control an installed service |
| `service_status <name>` | exit 0 if running, 1 if not |

Callers set spec vars before `service_install`: `SVC_PROGRAM` (newline-delimited argv),
`SVC_LOG`, and optionally `SVC_ENV` (newline `KEY=VALUE`), `SVC_PATH`, `SVC_PROCESS_TYPE`.
It is also runnable as a CLI so `dashboard/server.js` can shell out:
`bash scripts/service-helper.sh status scheduler`.

## Mechanism selection (auto, logged at install time)

| host | mechanism |
|---|---|
| **macOS** (`uname == Darwin`) | launchd user agent — `~/Library/LaunchAgents/com.superbot2.<name>.plist`, `launchctl load/unload/list`. Byte-for-key identical to the old installers. |
| **Linux with a reachable systemd user manager** | `systemd --user` units in `~/.config/systemd/user/`. Interval jobs → `superbot2-<name>.service` (`Type=oneshot`) + `superbot2-<name>.timer` (`OnActiveSec=1s` for the immediate first run, `OnUnitActiveSec=<interval>s` to repeat). Keepalive jobs → `superbot2-<name>.service` with `Restart=always`. Logs go to the same log file via `StandardOutput=append:` (systemd ≥ 240; older falls back to the journal). |
| **Linux without systemd** (bare WSL) | a self-managed **supervisor loop**: `setsid`+`nohup` background process with a PID file under `$SUPERBOT2_HOME/run/`, looping `run → sleep <interval|2s>`. Survives the installer exiting; stopped by group-killing the PID. |

Detection: systemd is chosen when `systemctl --user show-environment` succeeds; otherwise the
supervisor loop. The chosen mechanism is printed, e.g.
`service-helper: scheduler -> systemd --user timer superbot2-scheduler.timer (every 60s)`.

## Notes & known limitations

- **Old systemd (< 240) logs to the journal, not the log file.** `StandardOutput=append:`
  needs systemd ≥ 240; on older systemd the units are still generated but stdout/stderr go to
  the journal, so `tail -f ~/.superbot2/logs/<name>.log` shows an empty file. Read the logs
  with `journalctl --user -u superbot2-<name>.service -f` instead. (WSL's current distros
  ship systemd ≥ 249, so this only bites very old images.)
- **Timer cadence differs subtly from launchd.** launchd `StartInterval=60` is a fixed
  60-second period; the systemd timer uses `OnUnitActiveSec=60s`, i.e. 60s measured from the
  *last activation* of the job, so a slow run shifts the next fire slightly. Immaterial for the
  scheduler/heartbeat (their passes are sub-second and idempotent), but worth knowing.
- **SVC_* values are not XML/systemd-escaped** (pre-existing behavior, carried over from the
  original installers). All values in practice are `$HOME`-rooted paths with no `&`, `<`, `"`,
  so this is safe today; a home directory containing XML-special characters would need
  escaping added to `_svc_darwin_write_plist` / the systemd `ExecStart` builder. The
  supervisor-loop meta file *is* safe (scalars are `printf %q`-quoted, argv/env base64-encoded).

### Enabling systemd on WSL (recommended)

systemd on WSL is off unless enabled. To get the durable systemd-timer path:

```ini
# /etc/wsl.conf
[boot]
systemd=true
```

Then `wsl --shutdown` from Windows and reopen the distro. Without this, superbot2 still runs
via the supervisor-loop fallback (works while your shell/session is up; for cross-logout
persistence with systemd, additionally run `loginctl enable-linger $USER`).

## Installing on WSL / Linux

```bash
# prerequisites: node, npm, jq, tmux, git  (e.g. sudo apt install jq tmux git)
bash install.sh          # clones + runs scripts/setup.sh
# or, in an existing checkout:
bash scripts/setup.sh
```

`setup.sh` installs the scheduler through the abstraction and completes on Linux (the two
BSD-only `sed -i ''` calls are OS-branched). The heartbeat and watchdogs are installed
lazily by the `superbot2` launcher the first time it runs.

## Verifying it works on WSL

```bash
# 1. Which mechanism was chosen?
bash scripts/install-scheduler.sh          # prints "-> systemd --user timer ..." or "-> supervisor loop ..."

# 2. Is it running?
bash scripts/service-helper.sh status scheduler && echo RUNNING || echo STOPPED

# 3. systemd path — inspect the units + confirm the timer fires:
systemctl --user list-timers | grep superbot2
systemctl --user status superbot2-scheduler.timer
journalctl --user -u superbot2-scheduler.service --no-pager | tail
tail -f ~/.superbot2/logs/scheduler.log     # should get a line ~every 60s

# 4. supervisor-loop path — confirm the PID + log:
cat ~/.superbot2/run/service-scheduler.pid
tail -f ~/.superbot2/logs/scheduler.log

# 5. Heartbeat + watchdog (installed by the launcher, or install directly):
bash scripts/install-heartbeat.sh
bash scripts/service-helper.sh status heartbeat && echo RUNNING
```

Uninstall any service cross-platform:

```bash
bash scripts/service-helper.sh uninstall scheduler   # or heartbeat / orchestratorwatchdog / telegramwatchdog / wakenudge
```

## Tests

`test/service-helper.test.sh` (wired into `test/run.sh`) covers the Darwin plist shape, the
systemd unit/timer generation, and the supervisor-loop lifecycle. The Linux branches are
exercised on any host via a fake `uname`/`systemctl` PATH shim, so they run in macOS CI too.
