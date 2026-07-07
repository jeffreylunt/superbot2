#!/bin/bash
# reap-orphaned-dashboards.sh — kill leftover dashboard process trees that a SIGKILL'd
# launcher left behind, scoped strictly to ONE repo checkout.
#
# Sourced by ./superbot2 (start_dashboard_ui) and exercised directly by
# test/dashboard-reaper.test.sh. Exposes: reap_orphaned_dashboards <repo_dir>
#
# Why the original reaper missed these (three duplicate trees observed 2026-07-04): when a
# launcher is SIGKILL'd (its EXIT trap never runs), the tree it left is
#
#     npm run dev            (PPID 1  — reparented to init, the ONLY orphan)
#       └─ node .../concurrently
#            └─ npm run dev:api
#                 └─ node --watch ../dashboard/server.js
#
# The old reaper only looked at `concurrently` and `server.js` at PPID 1 — but those keep
# their npm parent ALIVE, so they are never at PPID 1 and never matched. The one true orphan
# is the `npm run dev` ROOT. We reap that root and its ENTIRE descendant tree.
#
# SAFETY: two guards on every candidate so we never touch a live launcher's children or a
# co-resident dashboard from a different checkout / ~/.otherbot install / a user's own
# `npm run dev`: (1) it must be a TRUE orphan (PPID 1); (2) its working directory must be
# under THIS repo_dir. cwd is the reliable repo-scoping signal — the `node --watch
# ../dashboard/server.js` child runs with a RELATIVE path in argv, so a command-substring
# match is not enough. The broad "npm run dev" pgrep is made safe by the cwd guard.

# _reaper_proc_cwd PID -> absolute cwd of the process, or empty. lsof is the portable way to
# read another process's cwd on macOS.
_reaper_proc_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

# _reaper_is_orphaned_in_repo REPO_DIR PID -> 0 if PID is a true orphan (PPID 1) whose cwd is
# REPO_DIR or a strict subpath. Anchored at a path separator so a sibling checkout
# ("$REPO_DIR-staging", "$REPO_DIR-worktree") is NOT matched.
_reaper_is_orphaned_in_repo() {
  local repo_dir="$1" pid="$2"
  [[ "$pid" == "$$" ]] && return 1
  local ppid
  ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [[ "$ppid" == "1" ]] || return 1          # only true orphans
  local cwd
  cwd=$(_reaper_proc_cwd "$pid")
  [[ -n "$cwd" && ( "$cwd" == "$repo_dir" || "$cwd" == "$repo_dir/"* ) ]]
}

# _reaper_kill_tree PID -> TERM PID and every descendant, leaves first. concurrently / vite /
# node keep their parent alive, so killing the root alone would just re-orphan them — we walk
# the whole subtree.
_reaper_kill_tree() {
  local root="$1" child
  for child in $(pgrep -P "$root" 2>/dev/null); do
    _reaper_kill_tree "$child"
  done
  kill -TERM "$root" 2>/dev/null || true
}

# reap_orphaned_dashboards REPO_DIR
reap_orphaned_dashboards() {
  local repo_dir="$1" pid
  [[ -z "$repo_dir" ]] && return 0

  # (1) Orphaned `npm run dev` ROOTS — the SIGKILL case that leaves a full duplicate tree.
  for pid in $(pgrep -f "npm run dev" 2>/dev/null); do
    _reaper_is_orphaned_in_repo "$repo_dir" "$pid" || continue
    echo "Reaping orphaned dashboard npm tree (PID $pid)..."
    _reaper_kill_tree "$pid"
  done

  # (2) Belt-and-suspenders: a concurrently / server.js child that ITSELF got reparented to
  # PPID 1 (its intermediate npm died) — the case the original reaper handled. Harmless if the
  # root sweep above already killed it (kill on a dead pid is a no-op).
  for pid in $(pgrep -f "dashboard-ui/node_modules/.bin/concurrently" 2>/dev/null); do
    _reaper_is_orphaned_in_repo "$repo_dir" "$pid" || continue
    echo "Reaping orphaned dashboard concurrently (PID $pid)..."
    _reaper_kill_tree "$pid"
  done
  for pid in $(pgrep -f "dashboard/server.js" 2>/dev/null); do
    _reaper_is_orphaned_in_repo "$repo_dir" "$pid" || continue
    echo "Reaping orphaned dashboard server.js (PID $pid)..."
    _reaper_kill_tree "$pid"
  done
}
