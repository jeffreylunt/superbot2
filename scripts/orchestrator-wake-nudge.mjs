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
import { tick, DEFAULT_CONFIG, newestUnreadMs, hasUnread, promptIsEmpty, extractPromptText, UNKNOWN_PROMPT } from '../dashboard/orchestrator-wake-nudge.mjs'

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

// --- inbound-vs-outbound times (unanswered-user gate) -----------------------
// newestUserMsgMs: newest dashboard-user message in team-lead.json, READ OR UNREAD —
// a drained inbox is exactly the answered-into-the-void case this gate exists for.
// newestReplyMs: newest team-lead reply in dashboard-user.json. Canary traffic is
// excluded on BOTH sides so an acked canary can't mask an unanswered Jeff message
// (and an unacked one can't spuriously trigger; the canary has its own alerting).
async function readUserReplyTimes() {
  const empty = { newestUserMsgMs: null, newestReplyMs: null }
  const inboxesDir = await resolveActiveTeamInboxesDir(TEAMS_DIR, {
    pinnedTeam: process.env.SUPERBOT2_NAME || '',
    fallbackInboxesDir: null,
  })
  if (!inboxesDir) return empty
  const ts = (m) => {
    const t = Date.parse(m.timestamp || '')
    return Number.isFinite(t) ? t : null
  }
  const newestOf = (arr, pred) => arr.reduce((best, m) => {
    if (!pred(m)) return best
    const t = ts(m)
    return t !== null && (best === null || t > best) ? t : best
  }, null)
  try {
    const inbox = JSON.parse(await readFile(join(inboxesDir, 'team-lead.json'), 'utf-8'))
    const outbox = JSON.parse(await readFile(join(inboxesDir, 'dashboard-user.json'), 'utf-8'))
    return {
      newestUserMsgMs: newestOf(inbox, (m) =>
        m.from === 'dashboard-user' && !String(m.text || '').startsWith('[canary ')),
      newestReplyMs: newestOf(outbox, (m) =>
        m.from === 'team-lead' && !String(m.text || '').startsWith('[canary-ack')),
    }
  } catch {
    return empty // fail closed: gate never fires on unreadable state
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
let cachedPaneAtMs = 0
// Existence re-verification alone is NOT enough: after the orchestrator crash-relaunches
// into a different window/session, a pane can still EXIST while no longer being the
// orchestrator's (observed live 2026-07-15: the daemon read a wrong pane as UNKNOWN_PROMPT
// for hours — blocked all nudges + false-fired the unreadable-prompt alert — until a
// process restart cleared in-memory state). A short TTL forces full rediscovery so ANY
// stale-cache condition self-heals within a minute instead of persisting until restart.
const PANE_CACHE_TTL_MS = Number(process.env.WAKE_NUDGE_PANE_CACHE_TTL_MS) || 60_000
async function discoverPane() {
  if (FORCED_PANE) return FORCED_PANE
  if (cachedPane && Date.now() - cachedPaneAtMs > PANE_CACHE_TTL_MS) cachedPane = null
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
  cachedPaneAtMs = Date.now()
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
    // -e keeps SGR escapes so extractPromptText can tell DIM (greyed suggestion /
    // placeholder) text from real user input — see the dim check in the dashboard lib.
    const { stdout } = await pexecFile('tmux', ['capture-pane', '-e', '-p', '-t', pane])
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
// Keep it SHORT: a long sentinel WRAPS across pane lines, and the post-type verify then
// reads only the first wrapped segment (a prefix), fails the match, and aborts before Enter
// — leaving stuck text that blocks every future nudge (live 2026-07-15). ~40 chars stays on
// one line in any realistic pane width; sendNudge's verify also tolerates wrapping as backup.
const WAKE_TEXT = (process.env.WAKE_NUDGE_TEXT ||
  '[wake-nudge] process your pending inbox')
  .replace(/[\r\n]+/g, ' ').trim()
// Unanswered-user variant: the message is already READ, so "process pending" would find
// nothing ("Idle — nothing to process", the exact trap). This sentinel must send it back
// into HISTORY. Kept short (one pane line) like WAKE_TEXT.
const WAKE_TEXT_UNANSWERED = (process.env.WAKE_NUDGE_UNANSWERED_TEXT ||
  '[wake-nudge] answer Jeff via SendMessage')
  .replace(/[\r\n]+/g, ' ').trim()

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function sendNudge(reason) {
  // Reason-specific sentinel: 'unanswered-user' must point at HISTORY (message already
  // read); everything else uses the pending-inbox text.
  const text = reason === 'unanswered-user' ? WAKE_TEXT_UNANSWERED : WAKE_TEXT
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
  await pexecFile('tmux', ['send-keys', '-t', pane, '-l', '--', text])

  // Post-type verify (review I1 belt-and-suspenders): only press Enter once the prompt shows
  // our sentinel. Accept an exact match OR a non-empty PREFIX of it: a long prompt wraps in
  // the pane and extractPromptText then returns only the first wrapped segment (a prefix) —
  // which aborted real nudges and left stuck text on 2026-07-15. A prefix is safe here because
  // the pre-type race guard already proved the prompt was empty, so a prefix of our own text
  // can only be our wrapped sentinel, never stray user input. Retry briefly: the UI may lag.
  const looksLikeSentinel = (t) => typeof t === 'string' && t.length > 0 && text.startsWith(t)
  let typed = null
  for (let i = 0; i < 6; i++) {
    await sleepMs(150)
    typed = extractPromptText((await capturePaneById(pane)) ?? '')
    if (looksLikeSentinel(typed)) break
  }
  if (!looksLikeSentinel(typed)) {
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
  readUserReplyTimes,
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
// Startup dialogs that BLOCK an automated relaunch: the folder-trust "Quick safety check"
// and the bypass-permissions consent. They render while the claude process is alive, so a
// naive supervisor sees "alive" and stalls forever (observed live 2026-07-03 16:02Z: the
// watchdog-relaunched orchestrator sat at the trust dialog). The health snapshot reports
// them so orchestrator-watchdog.sh can auto-confirm (it relaunches the same trusted
// $HOME + repo config every time).
const BOOT_DIALOG_RE = /Quick safety check|Bypass Permissions mode|WARNING: Claude Code running in Bypass Permissions/i

async function healthSnapshot() {
  const nowMs = Date.now()
  const backlogMs = await readInboxMtimeMs()
  const transcriptMs = await readTranscriptMtimeMs()
  const pane = await discoverPane()
  const cap = pane ? await capturePaneById(pane) : null
  // capturePaneById captures with -e (SGR escapes, needed by the dim-suggestion check in
  // promptIsEmpty). The dialog phrases below are styled mid-phrase, so on the RAW capture
  // "Enter to confirm" is not contiguous and the detection silently fails — observed live
  // 2026-07-04: the watchdog never auto-confirmed and the orchestrator relaunch-looped at
  // the trust dialog all night. Strip escapes before the phrase regexes.
  const plainCap = cap == null ? null : cap.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  return {
    paneFound: !!pane,
    paneId: pane || null,
    backlogAgeS: backlogMs == null ? null : Math.round((nowMs - backlogMs) / 1000),
    transcriptAgeS: transcriptMs == null ? null : Math.round((nowMs - transcriptMs) / 1000),
    // true = the orchestrator has NOT taken a turn since the newest unread message arrived
    transcriptBeforeBacklog: backlogMs != null && transcriptMs != null && transcriptMs < backlogMs,
    promptEmpty: cap != null && promptIsEmpty(cap),
    bootDialog: plainCap != null && BOOT_DIALOG_RE.test(plainCap) && /Enter to confirm/.test(plainCap),
    // The session feedback/rating modal ("1: Bad  2: Fine  3: Good  0: Dismiss") blocks
    // the session like a boot dialog but wants '0' (Dismiss), NOT Enter (which would
    // submit a rating). Observed live 2026-07-17 02:28Z: it modally blocked the
    // orchestrator ~25 min — messages queued unread until the canary alert fired.
    feedbackDialog: plainCap != null && /0: Dismiss/.test(plainCap) && /1: Bad/.test(plainCap),
    // Auth death (live 2026-07-20 + 2026-07-21 x2): the orchestrator's config-dir OAuth
    // token expires (shared-token rotation race) and every message answers "Login
    // expired". Two renderings observed live: the status-bar "Not logged in · Run /login"
    // (TUI chrome) AND — 2026-07-21 18:00Z — sessions where ONLY the ⏺ result line
    // "⏺ Login expired · Please run /login" appears (footer absent), which the
    // footer-only match MISSED for an hour of failed canaries. Match both; the ⏺-prefixed
    // exact line keeps quoted/echoed content from false-positiving. Watchdog auto-repairs.
    loginExpired: plainCap != null &&
      (/Not logged in · Run \/login/.test(plainCap) || /⏺ Login expired · Please run \/login/.test(plainCap)),
    // Hard permission gate (fires even under bypass-permissions — e.g. "Dangerous rm
    // operation on statically-unresolvable target", live 2026-08-18: an rm of the ENTIRE
    // runtime dir sat blocking with the cursor on "Yes" until manually cancelled). Jeff's
    // policy (2026-08-18): superbot must never freeze on a dialog — the watchdog
    // auto-DENIES these (Esc). Never auto-confirm: the safe unblocking answer is always
    // "no"; the orchestrator sees the denial and routes around it.
    dangerOpDialog: plainCap != null &&
      /Do you want to proceed\?/.test(plainCap) && /Esc to cancel/.test(plainCap),
    // Hard context exhaustion (live 2026-08-24): every turn aborts instantly with
    // "Context limit reached · /compact or /clear to continue" — the orchestrator can't
    // think at all, canaries fail, and the aborted micro-turns advance the transcript
    // enough to fool the transcript-after-message gate into "handled". Excluded while a
    // compaction is already running so the watchdog doesn't stack /compact commands.
    contextFull: plainCap != null &&
      /Context limit reached · \/compact or \/clear to continue/.test(plainCap) &&
      !/Compacting conversation/.test(plainCap),
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
  // UNKNOWN_PROMPT means the pane had no readable prompt line at all — e.g. scrolled up
  // in tmux copy-mode, or showing a dialog — NOT pending user text. Say so instead of
  // leaking the internal sentinel to Jeff (which is exactly what happened 2026-07-04).
  const unreadable = !pane || pending === UNKNOWN_PROMPT
  const text = unreadable
    ? `⚠️ Orchestrator wake-ups are blocked: I can't read its prompt box — the superbot2 ` +
      `tmux pane may be scrolled up (press q to leave copy-mode) or showing a dialog. ` +
      `Messages are piling up unread; check the pane.`
    : `⚠️ Orchestrator wake-ups are blocked: unsubmitted text is sitting in its prompt box` +
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
