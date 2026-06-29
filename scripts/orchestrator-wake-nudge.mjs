#!/usr/bin/env node
// Orchestrator active-wake nudge — EXECUTABLE wrapper (wires real tmux/fs into the tested
// decision loop in dashboard/orchestrator-wake-nudge.mjs).
//
// STATUS: DARK. Nothing installs/loads this by default. It is staged for a DELIBERATE human
// cutover (see scripts/install-wake-nudge.sh + knowledge/orchestrator-wake-mechanism.md).
//
// WHAT IT DOES
//   Every pollMs, it resolves the active orchestrator team-lead inbox + the orchestrator's tmux
//   pane + transcript jsonl, and — ONLY when a backlog has genuinely stalled and the orchestrator
//   is idle with an empty prompt (see tick()/decideNudge gates) — sends a single Enter keypress
//   to the pane to force the harness to take a turn and drain the inbox.
//
// SAFETY
//   - Fail-closed everywhere: any read/capture failure => no nudge.
//   - --dry-run: evaluate + log the decision but NEVER send keys (use this for the throwaway-
//     session shakedown before any real cutover).
//   - --once: run a single tick and exit (for testing/observation).
//   - Singleton pidfile so two copies can't both nudge.
//   - Target pane is auto-discovered (the pane whose process subtree runs `<repo>/superbot2`),
//     or forced with --pane <id> / WAKE_NUDGE_PANE (use a THROWAWAY pane for the shakedown).
//
// Usage:
//   node scripts/orchestrator-wake-nudge.mjs --dry-run            # observe only, no keys
//   node scripts/orchestrator-wake-nudge.mjs --once --dry-run     # single observation tick
//   node scripts/orchestrator-wake-nudge.mjs --pane %3 --dry-run  # target a throwaway pane

import { readdir, lstat, readFile, stat } from 'node:fs/promises'
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { resolveActiveTeamInboxesDir } from '../dashboard/active-team-inbox.mjs'
import { tick, DEFAULT_CONFIG } from '../dashboard/orchestrator-wake-nudge.mjs'

const pexecFile = promisify(execFile)
const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const SUPERBOT2_HOME = process.env.SUPERBOT2_HOME || join(homedir(), '.superbot2')
const TEAMS_DIR = join(SUPERBOT2_HOME, '.claude', 'teams')
// Where claude writes orchestrator transcripts (cwd=/Users/jeff => -Users-jeff project dir).
const PROJECTS_DIR = join(SUPERBOT2_HOME, '.claude', 'projects', '-Users-jeff')

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const ONCE = args.includes('--once')
const paneFlagIdx = args.indexOf('--pane')
const FORCED_PANE = paneFlagIdx >= 0 ? args[paneFlagIdx + 1] : process.env.WAKE_NUDGE_PANE || ''

const config = { ...DEFAULT_CONFIG }

function log(line) {
  process.stdout.write(`[wake-nudge] ${line}\n`)
}

// --- active inbox mtime ----------------------------------------------------
async function readInboxMtimeMs() {
  const inboxesDir = await resolveActiveTeamInboxesDir(TEAMS_DIR, {
    pinnedTeam: process.env.SUPERBOT2_NAME || '',
    fallbackInboxesDir: null,
  })
  if (!inboxesDir) return null
  const inbox = join(inboxesDir, 'team-lead.json')
  try {
    const raw = await readFile(inbox, 'utf-8')
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr) || arr.length === 0) return null // empty inbox => no backlog
    const st = await stat(inbox)
    return st.mtimeMs // when a message was last appended
  } catch {
    return null
  }
}

// --- transcript mtime (orchestrator turn activity) -------------------------
// The freshest jsonl in the projects dir is the live orchestrator transcript; it advances while
// a turn streams. (We use the freshest rather than a fixed session id so a context-fill restart
// under a new session id is followed automatically.)
async function readTranscriptMtimeMs() {
  try {
    const files = await readdir(PROJECTS_DIR)
    let best = null
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const st = await lstat(join(PROJECTS_DIR, f))
      if (!st.isFile()) continue
      if (!best || st.mtimeMs > best) best = st.mtimeMs
    }
    return best
  } catch {
    return null
  }
}

// --- orchestrator pane discovery -------------------------------------------
// Find the tmux pane whose process subtree runs `<repo>/superbot2`. We resolve the launcher PID,
// then match it to a pane by walking the pane_pid -> ... ancestry. Cached after first success.
let cachedPane = null
async function discoverPane() {
  if (FORCED_PANE) return FORCED_PANE
  if (cachedPane) {
    // Re-verify the cached pane still exists.
    try {
      await pexecFile('tmux', ['display-message', '-p', '-t', cachedPane, '#{pane_id}'])
      return cachedPane
    } catch { cachedPane = null }
  }
  // 1. Find the superbot2 launcher PID(s).
  let launcherPids = []
  try {
    const { stdout } = await pexecFile('pgrep', ['-f', `${REPO_DIR}/superbot2`])
    launcherPids = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch { /* none running */ }
  if (launcherPids.length === 0) return null

  // 2. Build a child->parent map via ps so we can walk ancestry.
  const ppidOf = new Map()
  try {
    const { stdout } = await pexecFile('ps', ['-eo', 'pid=,ppid='])
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/)
      if (m) ppidOf.set(m[1], m[2])
    }
  } catch { return null }

  // 3. For each tmux pane, see if any launcher PID is a descendant of the pane_pid.
  let panes = []
  try {
    const { stdout } = await pexecFile('tmux', ['list-panes', '-a', '-F', '#{pane_id}:#{pane_pid}'])
    panes = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
      .map((s) => { const i = s.indexOf(':'); return { id: s.slice(0, i), pid: s.slice(i + 1) } })
  } catch { return null }

  for (const lp of launcherPids) {
    // Walk lp up its ancestry; if we hit a pane_pid, that's the pane.
    let cur = lp
    const seen = new Set()
    while (cur && cur !== '1' && !seen.has(cur)) {
      seen.add(cur)
      const pane = panes.find((p) => p.pid === cur)
      if (pane) { cachedPane = pane.id; return pane.id }
      cur = ppidOf.get(cur)
    }
  }
  return null
}

async function getTitle() {
  const pane = await discoverPane()
  if (!pane) return null
  try {
    const { stdout } = await pexecFile('tmux', ['display-message', '-p', '-t', pane, '#{pane_title}'])
    return stdout.replace(/\n$/, '')
  } catch { return null }
}

async function capturePane() {
  const pane = await discoverPane()
  if (!pane) return null
  try {
    const { stdout } = await pexecFile('tmux', ['capture-pane', '-p', '-t', pane])
    return stdout
  } catch { return null }
}

async function sendNudge() {
  const pane = await discoverPane()
  if (!pane) { log('sendNudge: no pane resolved, skipping'); return }
  if (DRY_RUN) { log(`DRY-RUN: would send Enter to pane ${pane}`); return }
  // Send a bare Enter on the (verified-empty) prompt to force a harness turn.
  await pexecFile('tmux', ['send-keys', '-t', pane, 'Enter'])
}

const deps = {
  nowMs: () => Date.now(),
  readInboxMtimeMs,
  readTranscriptMtimeMs,
  capturePane,
  getTitle,
  sendNudge,
  log,
}

// --- singleton + main loop -------------------------------------------------
const PID_FILE = join(SUPERBOT2_HOME, '.pids', 'wake-nudge.pid')
function acquireSingleton() {
  mkdirSync(dirname(PID_FILE), { recursive: true })
  if (existsSync(PID_FILE)) {
    const old = readFileSync(PID_FILE, 'utf-8').trim()
    if (/^\d+$/.test(old)) {
      try { process.kill(Number(old), 0); log(`already running (PID ${old}), exiting`); process.exit(0) }
      catch { /* stale */ }
    }
  }
  writeFileSync(PID_FILE, String(process.pid))
  const cleanup = () => { try { unlinkSync(PID_FILE) } catch {} }
  process.on('exit', cleanup)
  process.on('SIGINT', () => { cleanup(); process.exit(0) })
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })
}

async function main() {
  let lastNudgeMs = null
  log(`starting (dry-run=${DRY_RUN} once=${ONCE} forcedPane=${FORCED_PANE || '(auto)'} pollMs=${config.pollMs})`)
  const runOne = async () => {
    try {
      const out = await tick(deps, config, lastNudgeMs)
      lastNudgeMs = out.lastNudgeMs
      if (!out.decision.nudge) log(`tick: no-nudge (${out.decision.reason})`)
    } catch (err) {
      log(`tick error (fail-closed): ${err.message}`)
    }
  }
  if (ONCE) { await runOne(); return }
  acquireSingleton()
  for (;;) {
    await runOne()
    await new Promise((r) => setTimeout(r, config.pollMs))
  }
}

main().catch((err) => { log(`fatal: ${err.message}`); process.exit(1) })
