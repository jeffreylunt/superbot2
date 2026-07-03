#!/usr/bin/env node
// Orchestrator active-wake nudge — EXECUTABLE wrapper (wires real tmux/fs into the tested
// decision loop in dashboard/orchestrator-wake-nudge.mjs).
//
// STATUS: DARK. Nothing installs/loads this by default. It is staged for a DELIBERATE human
// cutover (see scripts/install-wake-nudge.sh +
// ~/.superbot2/spaces/superbot2-app/knowledge/orchestrator-wake-mechanism.md).
//
// WHAT IT DOES
//   Every pollMs, it resolves the active orchestrator team-lead inbox + the orchestrator's tmux
//   pane + transcript jsonl, and — ONLY when a backlog has genuinely stalled and the orchestrator
//   is idle with an empty prompt (see tick()/decideNudge gates) — SUBMITS a short sentinel
//   message to the pane to force the harness to take a turn and drain the inbox. (A bare Enter
//   on an empty prompt does NOT start a turn — verified live 2026-07-03 on claude 2.1.199; the
//   harness drains the team inbox only at TURN START.)
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
import { tick, DEFAULT_CONFIG, newestUnreadMs, hasUnread, promptIsEmpty, extractPromptText } from '../dashboard/orchestrator-wake-nudge.mjs'

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

// --- newest UNREAD inbox message time --------------------------------------
// Returns the arrival time (ms) of the newest message the orchestrator plausibly hasn't read,
// or null if the inbox is empty / all-read (=> no backlog). (Review I2: use the per-message
// `read`/`timestamp` fields — which the inbox actually carries — instead of the file mtime, so
// an in-place `read:true` rewrite that bumps the file mtime can't masquerade as a fresh message,
// and the value genuinely means "newest unprocessed" as decideNudge's contract states.) Falls
// back to the file mtime only when messages lack a usable timestamp.
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
    if (!hasUnread(arr)) return null // empty / all-read => no backlog
    const newest = newestUnreadMs(arr)
    if (newest !== null) return newest
    // Has unread but no parseable per-message timestamp: fall back to the file mtime.
    const st = await stat(inbox)
    return st.mtimeMs
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
  // 1. Find the superbot2 launcher PID(s). (Review I1: anchor the match so a process whose argv
  //    merely *contains* the path — a child claude, a worker, even this script — isn't matched.
  //    `pgrep -f` matches the whole command line; we filter to entries whose command is exactly
  //    the launcher being run, i.e. `<sh> <REPO_DIR>/superbot2` with the path at a word boundary.)
  let launcherPids = []
  try {
    const { stdout } = await pexecFile('pgrep', ['-f', `${REPO_DIR}/superbot2`])
    const candidates = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    // Re-read each candidate's full command and keep only true launcher invocations:
    // the superbot2 path must appear as a standalone argv token (followed by end/space),
    // and the command must be a shell running it (not `claude`, `node`, `grep`, etc.).
    const launcherRe = new RegExp(`(^|\\s)${REPO_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/superbot2(\\s|$)`)
    for (const pid of candidates) {
      try {
        const { stdout: cmd } = await pexecFile('ps', ['-o', 'command=', '-p', pid])
        const c = cmd.trim()
        if (launcherRe.test(c) && /(^|\/)(ba|z|d|)sh\b/.test(c)) launcherPids.push(pid)
      } catch { /* pid gone */ }
    }
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

  // Resolve the DISTINCT set of panes that host a launcher subtree. (Review I1: if more than one
  // distinct pane qualifies, the target is AMBIGUOUS — fail closed and refuse to nudge rather
  // than guessing, so we can never send Enter to the wrong pane.)
  const matchedPanes = new Set()
  for (const lp of launcherPids) {
    let cur = lp
    const seen = new Set()
    while (cur && cur !== '1' && !seen.has(cur)) {
      seen.add(cur)
      const pane = panes.find((p) => p.pid === cur)
      if (pane) { matchedPanes.add(pane.id); break }
      cur = ppidOf.get(cur)
    }
  }
  if (matchedPanes.size === 0) return null
  if (matchedPanes.size > 1) {
    log(`pane discovery AMBIGUOUS (${[...matchedPanes].join(',')}) — failing closed, no nudge`)
    return null
  }
  cachedPane = [...matchedPanes][0]
  return cachedPane
}

async function getTitle() {
  const pane = await discoverPane()
  if (!pane) return null
  try {
    const { stdout } = await pexecFile('tmux', ['display-message', '-p', '-t', pane, '#{pane_title}'])
    return stdout.replace(/\n$/, '')
  } catch { return null }
}

async function capturePaneById(pane) {
  try {
    const { stdout } = await pexecFile('tmux', ['capture-pane', '-p', '-t', pane])
    return stdout
  } catch { return null }
}

async function capturePane() {
  const pane = await discoverPane()
  if (!pane) return null
  return capturePaneById(pane)
}

// The sentinel the nudge submits. A bare Enter on an EMPTY prompt does NOT start a turn
// (verified live 2026-07-03: NUDGE sent 15:24:27Z, Enter delivered, no turn, backlog stayed
// stalled) — the harness only drains the team inbox at TURN START, so the nudge must submit
// an actual message. The empty-prompt gate guarantees we never clobber user-typed text, and
// the cooldown caps this at one short sentinel turn per stall window.
// Newlines are stripped (review M1): a \n inside `-l` text would submit multiple turns.
const WAKE_TEXT = (process.env.WAKE_NUDGE_TEXT ||
  '[wake-nudge] Your team inbox has a stalled backlog — process pending messages now.')
  .replace(/[\r\n]+/g, ' ').trim()

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function sendNudge() {
  const pane = await discoverPane()
  if (!pane) { log('sendNudge: no pane resolved, skipping'); return }
  if (DRY_RUN) { log(`DRY-RUN: would submit wake sentinel to pane ${pane}`); return }

  // TOCTOU race guard (review I1/I2): tick()'s prompt capture is several tmux round-trips old
  // by now — the user could have started typing. Re-capture THIS pane (no re-discovery)
  // immediately before typing and abort if the prompt is no longer empty. Fail-closed.
  const pre = await capturePaneById(pane)
  if (pre === null || !promptIsEmpty(pre)) {
    log('sendNudge ABORTED: prompt no longer empty at send time (race guard) — no keys sent')
    return
  }

  // '--' ends tmux option parsing so an operator-set WAKE_NUDGE_TEXT starting with '-' can't
  // be misread as send-keys flags (review M1). -l types it literally (no key-name lookup).
  await pexecFile('tmux', ['send-keys', '-t', pane, '-l', '--', WAKE_TEXT])

  // Post-type verify (review I1 belt-and-suspenders): only press Enter if the prompt now
  // contains EXACTLY the sentinel. Concurrent keystrokes / rendering surprises => leave the
  // text unsubmitted (visible + editable — strictly safer than submitting a merged line) and
  // log loudly. Retry briefly first: the UI may lag a beat before echoing the typed text.
  let typed = null
  for (let i = 0; i < 6; i++) {
    await sleepMs(150)
    typed = extractPromptText((await capturePaneById(pane)) ?? '')
    if (typed === WAKE_TEXT) break
  }
  if (typed !== WAKE_TEXT) {
    log(`sendNudge ABORTED before Enter: prompt reads ${JSON.stringify((typed || '').slice(0, 100))}, expected the sentinel — left unsubmitted, check pane ${pane}`)
    return
  }
  try {
    await pexecFile('tmux', ['send-keys', '-t', pane, 'Enter'])
  } catch (err) {
    // Sentinel is now sitting unsubmitted in the prompt; future empty-prompt gates will hold
    // until it's cleared/submitted. Loud log so it's visible (review M2).
    log(`sendNudge: Enter FAILED after typing sentinel — it remains in the prompt of ${pane}: ${err.message}`)
    throw err
  }
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

// --health: print a one-shot JSON liveness snapshot (for orchestrator-watchdog.sh wedge
// detection) and exit. Reuses the exact same discovery/parsing as the nudge gates. Never
// takes the singleton pidfile and never sends keys.
async function healthSnapshot() {
  const nowMs = Date.now()
  const backlogMs = await readInboxMtimeMs()
  const transcriptMs = await readTranscriptMtimeMs()
  const pane = await discoverPane()
  const cap = pane ? await capturePaneById(pane) : null
  return {
    paneFound: !!pane,
    backlogAgeS: backlogMs == null ? null : Math.round((nowMs - backlogMs) / 1000),
    transcriptAgeS: transcriptMs == null ? null : Math.round((nowMs - transcriptMs) / 1000),
    // true = the orchestrator has NOT taken a turn since the newest unread message arrived
    transcriptBeforeBacklog: backlogMs != null && transcriptMs != null && transcriptMs < backlogMs,
    promptEmpty: cap != null && promptIsEmpty(cap),
  }
}

// --- stuck-prompt Telegram alert --------------------------------------------
// 'prompt-not-empty' is decideNudge's FINAL gate: that reason means a stalled backlog
// exists, the orchestrator is idle, cooldown has passed — and ONLY unsubmitted text in
// the prompt box is blocking the wake. By design we never clobber that text, which means
// a forgotten half-typed command silently blocks ALL wake-ups indefinitely (bit Jeff
// twice on 2026-07-03: Telegram tests went unanswered for 40+ min each time). After
// PROMPT_ALERT_TICKS consecutive blocked ticks, tell Jeff on Telegram — plain text via
// the bot API directly (no parse_mode, nothing to fail), once per stuck episode.
const PROMPT_ALERT_TICKS = Number(process.env.WAKE_NUDGE_PROMPT_ALERT_TICKS) || 24 // ~2 min at 5s polls
let promptBlockedTicks = 0
let promptAlertSent = false

async function sendStuckPromptAlert() {
  const cfgPath = join(SUPERBOT2_HOME, 'config.json')
  const tg = JSON.parse(await readFile(cfgPath, 'utf8')).telegram || {}
  if (!tg.botToken || !tg.chatId) { log('stuck-prompt alert skipped: no telegram config'); return }
  const pane = await discoverPane()
  const pending = pane ? extractPromptText((await capturePaneById(pane)) ?? '') : ''
  const text = `⚠️ Orchestrator wake-ups are blocked: unsubmitted text is sitting in its prompt box` +
    (pending ? `:\n\n"${pending.slice(0, 120)}"` : '.') +
    `\n\nMessages are piling up unread. Press Enter in the superbot2 tmux pane to submit it, or clear the line — wake-nudge will take over from there.`
  const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: tg.chatId, text }),
    signal: AbortSignal.timeout(15000),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(json.description || 'sendMessage not ok')
}

async function trackStuckPrompt(reason) {
  if (reason !== 'prompt-not-empty') {
    // Episode over (text submitted/cleared, or some other gate took precedence) — re-arm.
    promptBlockedTicks = 0
    promptAlertSent = false
    return
  }
  promptBlockedTicks++
  if (promptAlertSent || promptBlockedTicks < PROMPT_ALERT_TICKS) return
  promptAlertSent = true // latch first: even a failed send shouldn't spam every tick
  try {
    await sendStuckPromptAlert()
    log(`stuck-prompt ALERT sent to Telegram after ${promptBlockedTicks} blocked ticks`)
  } catch (err) {
    log(`stuck-prompt alert FAILED (will not retry this episode): ${err.message}`)
  }
}

async function main() {
  if (args.includes('--health')) {
    process.stdout.write(JSON.stringify(await healthSnapshot()) + '\n')
    return
  }
  let lastNudgeMs = null
  log(`starting (dry-run=${DRY_RUN} once=${ONCE} forcedPane=${FORCED_PANE || '(auto)'} pollMs=${config.pollMs})`)
  const runOne = async () => {
    try {
      const out = await tick(deps, config, lastNudgeMs)
      lastNudgeMs = out.lastNudgeMs
      if (!out.decision.nudge) log(`tick: no-nudge (${out.decision.reason})`)
      await trackStuckPrompt(out.decision.reason)
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
