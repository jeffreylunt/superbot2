#!/usr/bin/env node
// telegram-watcher.mjs — Long-poll Telegram Bot API, relay messages to superbot2 dashboard
// Usage: node telegram-watcher.mjs
//
// Reads config from ~/.superbot2/config.json (telegram.botToken, telegram.chatId, telegram.enabled)
// Long polls getUpdates with 30s timeout
// Relays inbound messages to POST http://localhost:3274/api/messages
// Monitors orchestrator replies and sends them back to Telegram
// Monitors needs_human escalations and sends rich cards with inline buttons
// Handles /status, /escalations, /recent, /schedule, /todo, /help commands
// Typing indicator while waiting for orchestrator reply

import { readFile, writeFile, readdir, unlink, stat, lstat, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename, extname } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'

const SUPERBOT_DIR = process.env.SUPERBOT2_HOME || join(homedir(), '.superbot2')
const SPACES_DIR = join(SUPERBOT_DIR, 'spaces')
const CONFIG_PATH = join(SUPERBOT_DIR, 'config.json')
const PID_FILE = join(SUPERBOT_DIR, 'telegram.pid')
const LAST_SENT_FILE = join(SUPERBOT_DIR, 'telegram-last-sent-idx.txt')
const LAST_UPDATE_ID_FILE = join(SUPERBOT_DIR, 'telegram-last-update-id.txt')
const SENT_ESCALATIONS_FILE = join(SUPERBOT_DIR, 'telegram-sent-escalations.json')
const MESSAGE_MAP_FILE = join(SUPERBOT_DIR, 'telegram-message-map.json')
const HEARTBEAT_FILE = join(SUPERBOT_DIR, 'telegram-heartbeat.txt')
// Outbound liveness: written at the end of every checkForReplies cycle so the
// watchdog can detect a stalled outbound relay independently of the inbound loop.
const OUTBOUND_HEARTBEAT_FILE = join(SUPERBOT_DIR, 'telegram-outbound-heartbeat.txt')
const ESCALATIONS_DIR = join(SUPERBOT_DIR, 'escalations', 'needs_human')
// Team name is NO LONGER hardcoded to 'superbot2'. The orchestrator registers under
// a SESSION-based team name (e.g. 'session-475577c1') because TeamCreate is unavailable
// in the current harness, so its outbound replies land in
//   .claude/teams/<session-name>/inboxes/dashboard-user.json
// which changes across orchestrator restarts. We auto-detect the ACTIVE team inbox each
// poll cycle (most-recently-modified dashboard-user.json) instead of a fixed name.
// SUPERBOT2_NAME, if explicitly set, forces a fixed team (back-compat / testing override).
const SUPERBOT2_NAME = process.env.SUPERBOT2_NAME || ''
const TEAMS_DIR = join(SUPERBOT_DIR, '.claude', 'teams')
// Legacy default used only as a last-resort fallback when no team inbox can be found.
const LEGACY_TEAM_NAME = 'superbot2'
// Resolved at runtime (see refreshActiveInbox). Re-resolved every poll cycle.
let TEAM_INBOXES_DIR = SUPERBOT2_NAME
  ? join(TEAMS_DIR, SUPERBOT2_NAME, 'inboxes')
  : join(TEAMS_DIR, LEGACY_TEAM_NAME, 'inboxes')
const DASHBOARD_API = `http://localhost:${process.env.SUPERBOT2_API_PORT || '3274'}/api`
// Override the API base in tests to point at a mock server (default: real Telegram).
const TELEGRAM_API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org/bot'
const POLL_TIMEOUT = 30
const TYPING_INTERVAL = 3000
const REPLY_POLL_INTERVAL = Number(process.env.TG_REPLY_POLL_INTERVAL) || 3000
const ESCALATION_POLL_INTERVAL = 10000
// Active-inbox switch hysteresis: when two team inboxes briefly look "active" (e.g. a
// restart/handoff overlap), a naive most-recent-mtime pick can FLIP between them, and each
// flip resets the counter to 0 and re-forwards the whole inbox → duplicate Telegram blasts.
// We only switch away from the current inbox if a DIFFERENT one is newer than our current
// inbox's LIVE mtime by at least this margin. While our inbox is still being written, it wins.
const INBOX_SWITCH_HYSTERESIS_MS = Number(process.env.TG_INBOX_SWITCH_HYSTERESIS_MS) || 15000
// On shutdown, drain pending outbound messages before exiting (graceful restart).
// Bounded so a wedged loop can't make shutdown hang; the watchdog SIGKILLs as a backstop.
const GRACEFUL_FLUSH_TIMEOUT_MS = Number(process.env.TG_GRACEFUL_FLUSH_TIMEOUT_MS) || 8000

// --- State ---

let botToken = ''
let chatId = ''
let lastUpdateId = -1 // -1 means "not loaded yet, skip old updates on first run"
let lastSentReplyCount = 0
// Whether refreshActiveInbox has locked onto a real inbox at least once. Used so the
// FIRST resolution (at startup) doesn't trigger the switch-reset, but later switches do.
let activeInboxResolved = false
// The dashboard-user.json mtime of the inbox we're CURRENTLY locked onto, captured when we
// locked on. Used for switch hysteresis: we only flip to a different team's inbox if that
// inbox is strictly newer than our current inbox's LIVE mtime by INBOX_SWITCH_HYSTERESIS_MS.
// While our current inbox is still being appended to (active session), nothing can steal it.
let activeInboxDashMtime = 0
let sentEscalationIds = new Set()
let typingInterval = null
let waitingForReply = false
let shuttingDown = false
// Re-entrancy guard: checkForReplies is driven by setInterval, which does NOT wait
// for the previous (async) invocation to finish. If a send is slow, invocations would
// stack and double-send the same reply. This flag ensures only one cycle runs at a time.
let replyCheckRunning = false

// Baseline index: when user sends a message via Telegram, we record the current
// inbox length so we only forward replies that arrived after that point.
let replyBaseline = 0

// In-memory map: short callback key -> full escalation ID
// Populated when escalation cards are sent, used when callback buttons are clicked
let callbackMap = new Map() // e.g. "e1" -> "esc-personal-assistant-email-triage-..."
let callbackCounter = 0

// Map: Telegram message_id of sent escalation card -> escalation ID
// Used to detect freeform replies to escalation cards
let escalationMessageMap = new Map() // e.g. 12345 -> "esc-personal-assistant-email-triage-..."

// Message ID tracking for reply threading
// lastUserMessageId: the Telegram message_id of the user's most recent non-command message
// lastUserMessageAt: epoch ms when that message was received (freshness gate)
// messageMap: maps inbox index -> Telegram message_id of the bot's sent reply
// userMessageAnchors: array of {inboxCountAtSend, telegramMessageId, at} recording which
//   user message was active when each inbox reply arrived. Used to thread each
//   orchestrator reply back to the correct user message instead of always the latest.
let lastUserMessageId = null
let lastUserMessageAt = 0
let messageMap = {} // { inboxIdx: telegramMessageId, ... } + { lastUserMessageId, lastUserMessageAt }
let userMessageAnchors = [] // [{inboxCountAtSend, telegramMessageId, at}, ...]
const MAX_MESSAGE_MAP_SIZE = 200 // Keep map bounded
const MAX_ANCHORS = 200 // Keep anchors bounded
// Reply-threading FRESHNESS GATE (2026-07-03 incident): never thread a reply onto a user
// message older than this. Stale/mis-mapped reply_to targets (anchors surviving an
// active-inbox switch pointed at a PRIOR session's messages) made watcher replies not
// surface for the user, while a plain un-threaded send demonstrably delivered. When a
// threading target isn't provably fresh, send un-threaded — delivery beats threading.
// Env override TG_THREAD_MAX_AGE_MS: any finite value >= 0 is honored (0 disables
// threading entirely); unset/empty/invalid falls back to the default.
const THREAD_MAX_AGE_MS = (() => {
  const raw = process.env.TG_THREAD_MAX_AGE_MS
  const n = raw === undefined || raw === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 30 * 60 * 1000
})()

// Message editing: track last sent text message for rapid-fire reply coalescing
let lastSentBotMessageId = null // Telegram message_id of the last text reply sent
let lastSentBotMessageTime = 0  // timestamp when it was sent
let lastSentBotMessageText = '' // text content of the last sent message
const EDIT_WINDOW_MS = 5000     // edit instead of new message if within 5 seconds

// --- Helpers ---

function log(msg) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] telegram-watcher: ${msg}`)
}

function logError(msg) {
  const ts = new Date().toISOString()
  console.error(`[${ts}] telegram-watcher: ${msg}`)
}

async function readJsonFile(filePath) {
  try {
    const data = await readFile(filePath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return null
  }
}

async function writeJsonFile(filePath, data) {
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

async function loadConfig() {
  const config = await readJsonFile(CONFIG_PATH)
  if (!config?.telegram) return null
  return config.telegram
}

async function saveConfigField(field, value) {
  const config = await readJsonFile(CONFIG_PATH) || {}
  if (!config.telegram) config.telegram = {}
  config.telegram[field] = value
  await writeJsonFile(CONFIG_PATH, config)
}

// --- Active team inbox resolution ---

// Return the mtime (ms) of a real file, or null if it doesn't exist / isn't a
// regular file. SYMLINKS are deliberately rejected: a stale band-aid symlink (or a
// self-referential one) must never be chosen as the active inbox.
async function fileMtimeMs(filePath) {
  try {
    const st = await lstat(filePath)
    if (st.isSymbolicLink() || !st.isFile()) return null
    return st.mtimeMs
  } catch {
    return null
  }
}

// Find the candidate active team inbox: the most-recently-modified real (non-symlink)
// dashboard-user.json across teams/*. Selection is by dashboard-user.json mtime ALONE —
// team-lead.json mtime is deliberately NOT a selection signal (an inbound relay merely
// touching team-lead.json must never change which inbox we forward FROM; that was an
// oscillation vector). team-lead.json mtime only breaks exact dashMtime ties (rare), to
// keep the choice deterministic. Returns { inboxesDir, dashMtime } or null if none found.
async function findCandidateInbox() {
  let teamDirs = []
  try {
    teamDirs = await readdir(TEAMS_DIR)
  } catch {
    return null
  }

  let best = null // { inboxesDir, dashMtime, leadMtime }
  for (const team of teamDirs) {
    const inboxesDir = join(TEAMS_DIR, team, 'inboxes')
    const dashMtime = await fileMtimeMs(join(inboxesDir, 'dashboard-user.json'))
    if (dashMtime === null) continue // no real dashboard-user.json here (or it's a symlink)
    const leadMtime = (await fileMtimeMs(join(inboxesDir, 'team-lead.json'))) ?? 0
    const isBetter =
      !best ||
      dashMtime > best.dashMtime ||
      (dashMtime === best.dashMtime && leadMtime > best.leadMtime)
    if (isBetter) best = { inboxesDir, dashMtime, leadMtime }
  }
  return best ? { inboxesDir: best.inboxesDir, dashMtime: best.dashMtime } : null
}

// Resolve the inboxes dir when SUPERBOT2_NAME pins a fixed team, or as a last-resort
// fallback. Returns just the path.
function fixedOrFallbackInboxesDir() {
  if (SUPERBOT2_NAME) return join(TEAMS_DIR, SUPERBOT2_NAME, 'inboxes')
  return join(TEAMS_DIR, LEGACY_TEAM_NAME, 'inboxes')
}

// Re-resolve the active inbox and update TEAM_INBOXES_DIR. When the active inbox PATH
// changes (orchestrator restarted under a new session/team name), the new
// dashboard-user.json is a DIFFERENT, fresh inbox — our lastSentReplyCount no longer
// refers to its messages. We reset the counter to 0 ONCE on switch so we don't skip the
// new inbox's content AND don't treat old indices as already-sent. This mirrors the
// existing "inbox truncated -> new session" behavior (forward the new inbox once); the
// per-reply counter persistence then prevents any re-send on subsequent cycles.
//
// SWITCH HYSTERESIS (anti-oscillation): during a restart/handoff overlap two team inboxes
// can briefly both look recent. A naive most-recent pick would FLIP between them, and each
// flip re-blasts the whole inbox to Telegram (duplicate messages to the user). So once
// we're locked onto an inbox we only switch AWAY if a DIFFERENT inbox's dashMtime exceeds
// our CURRENT inbox's LIVE dashMtime by INBOX_SWITCH_HYSTERESIS_MS. While our inbox is
// still being appended to (the live session), it always wins and we never flip.
async function refreshActiveInbox() {
  // Pinned-team override / no-candidate fallback: behave like the old direct path, but
  // still honor the first-resolution-doesn't-reset rule.
  if (SUPERBOT2_NAME) {
    return applyResolvedInbox(fixedOrFallbackInboxesDir(), null)
  }

  const candidate = await findCandidateInbox()
  if (!candidate) {
    return applyResolvedInbox(fixedOrFallbackInboxesDir(), null)
  }

  // Not yet locked onto anything → take the candidate as-is (startup).
  if (!activeInboxResolved) {
    return applyResolvedInbox(candidate.inboxesDir, candidate.dashMtime)
  }

  // Already on this inbox → just refresh its live mtime so hysteresis measures against
  // the CURRENT mtime (an actively-written inbox keeps raising the bar for challengers).
  if (candidate.inboxesDir === TEAM_INBOXES_DIR) {
    const liveMtime = await fileMtimeMs(join(TEAM_INBOXES_DIR, 'dashboard-user.json'))
    if (liveMtime !== null) activeInboxDashMtime = liveMtime
    return TEAM_INBOXES_DIR
  }

  // A DIFFERENT inbox is the candidate. Only switch if it's meaningfully newer than our
  // current inbox's LIVE mtime — otherwise the current (still-active) session keeps it.
  const currentLiveMtime =
    (await fileMtimeMs(join(TEAM_INBOXES_DIR, 'dashboard-user.json'))) ?? activeInboxDashMtime
  if (candidate.dashMtime > currentLiveMtime + INBOX_SWITCH_HYSTERESIS_MS) {
    return applyResolvedInbox(candidate.inboxesDir, candidate.dashMtime)
  }
  // Hold — challenger isn't decisively newer; avoid an oscillating flip + re-blast.
  return TEAM_INBOXES_DIR
}

// Apply a resolved inbox path, performing the one-time switch-reset when appropriate.
// dashMtime may be null (pinned/fallback paths) — we look it up so hysteresis stays valid.
async function applyResolvedInbox(resolved, dashMtime) {
  if (resolved !== TEAM_INBOXES_DIR) {
    const previous = TEAM_INBOXES_DIR
    TEAM_INBOXES_DIR = resolved
    // Only treat it as a "switch" (reset counter) if we'd previously locked onto a real
    // inbox. On the very first resolution at startup, loadLastSentCount + the startup
    // truncation check already establish the correct baseline, so don't clobber it here.
    if (activeInboxResolved) {
      // NOTE: on a switch we deliberately ABANDON any in-flight undelivered reply from the
      // PRIOR session's inbox (resetting the counter to 0 here points us at the NEW inbox).
      // That prior session is gone; its un-sent tail can't be meaningfully delivered to the
      // user anymore. This is the one intentional exception to the otherwise-strict
      // "never silently drop an outbound reply" guarantee in checkForReplies.
      log(`Active team inbox switched: ${previous} -> ${resolved} — resetting outbound counter to 0`)
      lastSentReplyCount = 0
      replyBaseline = 0
      // Anchors map OLD-inbox reply indices -> user message ids. The new inbox's indices
      // restart at 0, so keeping them MIS-THREADS every new reply onto the previous
      // session's (stale) user messages — root cause of the 2026-07-03 "replies don't
      // surface" incident. Drop them; fresh anchors are rebuilt from new inbound messages.
      userMessageAnchors = []
      await saveLastSentCount(lastSentReplyCount)
      await saveMessageMap()
    }
  }
  activeInboxResolved = true
  const m = dashMtime ?? (await fileMtimeMs(join(TEAM_INBOXES_DIR, 'dashboard-user.json')))
  if (m !== null && m !== undefined) activeInboxDashMtime = m
  return TEAM_INBOXES_DIR
}

// --- Image path detection ---

const IMAGE_PATH_RE = /((?:~\/|\/)[^\s]+\.(?:png|jpe?g|gif|webp))/gi

function extractImagePaths(text) {
  IMAGE_PATH_RE.lastIndex = 0
  const paths = []
  let match
  while ((match = IMAGE_PATH_RE.exec(text)) !== null) {
    paths.push(match[1])
  }
  IMAGE_PATH_RE.lastIndex = 0
  return paths
}

function stripImagePaths(text) {
  IMAGE_PATH_RE.lastIndex = 0
  return text.replace(IMAGE_PATH_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

function resolveImagePath(p) {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

async function filterExistingImages(paths) {
  const existing = []
  for (const p of paths) {
    const resolved = resolveImagePath(p)
    try {
      const s = await stat(resolved)
      if (s.isFile()) existing.push(resolved)
    } catch {
      // file doesn't exist, skip
    }
  }
  return existing
}

const UPLOADS_DIR = join(SUPERBOT_DIR, 'uploads')

// --- Download inbound Telegram photos ---

async function downloadTelegramFile(fileId) {
  // Step 1: Get file path from Telegram
  const fileInfo = await tg('getFile', { file_id: fileId })
  if (!fileInfo?.file_path) {
    throw new Error('getFile returned no file_path')
  }

  // Step 2: Download the file
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`
  const ext = extname(fileInfo.file_path) || '.jpg'
  const filename = `telegram-${Date.now()}${ext}`
  const destPath = join(UPLOADS_DIR, filename)

  await mkdir(UPLOADS_DIR, { recursive: true })

  const res = await fetch(downloadUrl)
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status}`)
  }

  const buffer = Buffer.from(await res.arrayBuffer())
  await writeFile(destPath, buffer)
  log(`Downloaded photo: ${destPath} (${buffer.length} bytes)`)
  return destPath
}

// --- Telegram API ---

const MAX_RETRIES = 3
const RETRY_BACKOFF = [1000, 2000, 4000] // exponential backoff
// Per-request timeout for ALL Telegram API calls. Without this, a half-open /
// black-holed TCP connection makes fetch() hang forever — which is exactly what
// silently wedged the outbound relay loop on 2026-05-27 (see knowledge/telegram-outbound-stall.md).
// A timeout turns an indefinite hang into a retryable error so the loop can advance.
const TG_REQUEST_TIMEOUT_MS = Number(process.env.TG_REQUEST_TIMEOUT_MS) || 20000

function isRetryableError(err) {
  const msg = (err.message || '').toLowerCase()
  const name = (err.name || '').toLowerCase()
  return name === 'timeouterror' ||
    name === 'aborterror' ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('econnrefused') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('socket hang up') ||
    msg.includes('aborted') ||
    msg.includes('timeout')
}

async function tg(method, body) {
  const url = `${TELEGRAM_API}${botToken}/${method}`
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(TG_REQUEST_TIMEOUT_MS) })
      const json = await res.json()
      if (!json.ok) {
        throw new Error(`Telegram API ${method} failed: ${json.description || 'unknown error'}`)
      }
      return json.result
    } catch (err) {
      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        const delay = RETRY_BACKOFF[attempt - 1] || 4000
        log(`tg(${method}) attempt ${attempt}/${MAX_RETRIES} failed: ${err.message} — retrying in ${delay}ms`)
        await sleep(delay)
        continue
      }
      throw err
    }
  }
  // Defensive backstop: never fall off the end and return undefined (a silent
  // "sent with no message_id" would advance the outbound counter and DROP a
  // message — exactly the silent-loss failure mode this hardening fights).
  throw new Error(`tg(${method}) exhausted retries without a result`)
}

async function tgMultipart(method, fields, files) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`
      const CRLF = Buffer.from('\r\n')
      const buffers = []

      // Add text fields
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue
        buffers.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
        ))
      }

      // Add file fields
      for (const { field, filePath, filename } of files) {
        const fileData = await readFile(filePath)
        const name = filename || basename(filePath)
        buffers.push(Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`
        ))
        buffers.push(fileData)
        buffers.push(CRLF)
      }

      // Closing boundary
      buffers.push(Buffer.from(`--${boundary}--\r\n`))
      const body = Buffer.concat(buffers)

      const url = `${TELEGRAM_API}${botToken}/${method}`
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
        // Larger timeout for uploads (photos/documents can be big), still bounded.
        signal: AbortSignal.timeout(TG_REQUEST_TIMEOUT_MS * 3),
      })
      const json = await res.json()
      if (!json.ok) {
        throw new Error(`Telegram API ${method} (multipart) failed: ${json.description || 'unknown error'}`)
      }
      return json.result
    } catch (err) {
      if (attempt < MAX_RETRIES && isRetryableError(err)) {
        const delay = RETRY_BACKOFF[attempt - 1] || 4000
        log(`tgMultipart(${method}) attempt ${attempt}/${MAX_RETRIES} failed: ${err.message} — retrying in ${delay}ms`)
        await sleep(delay)
        continue
      }
      throw err
    }
  }
  // Defensive backstop — see tg().
  throw new Error(`tgMultipart(${method}) exhausted retries without a result`)
}

async function sendPhoto(filePath, caption, replyToMessageId) {
  if (!chatId) return null
  const fields = {
    chat_id: chatId,
    ...(caption ? { caption, parse_mode: 'HTML' } : {}),
    ...(replyToMessageId ? { reply_to_message_id: String(replyToMessageId), allow_sending_without_reply: 'true' } : {}),
  }
  return tgMultipart('sendPhoto', fields, [{ field: 'photo', filePath }])
}

async function sendMediaGroup(filePaths, caption, replyToMessageId) {
  if (!chatId) return null
  // sendMediaGroup requires media as JSON array with attach:// references
  // and the actual files as multipart fields
  const media = filePaths.map((_, i) => ({
    type: 'photo',
    media: `attach://photo${i}`,
    ...(i === 0 && caption ? { caption, parse_mode: 'HTML' } : {}),
  }))
  const fields = {
    chat_id: chatId,
    media: JSON.stringify(media),
    ...(replyToMessageId ? { reply_to_message_id: String(replyToMessageId), allow_sending_without_reply: 'true' } : {}),
  }
  const files = filePaths.map((filePath, i) => ({
    field: `photo${i}`,
    filePath,
  }))
  return tgMultipart('sendMediaGroup', fields, files)
}

async function sendMessage(text, opts = {}) {
  if (!chatId) return null
  const body = {
    chat_id: chatId,
    text,
    parse_mode: opts.parseMode || 'HTML',
    ...opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {},
    ...opts.replyToMessageId ? { reply_to_message_id: opts.replyToMessageId, allow_sending_without_reply: true } : {},
  }
  try {
    return await tg('sendMessage', body)
  } catch (err) {
    if (!isParseEntitiesError(err)) throw err
    // Malformed HTML from the orchestrator's reply — resend as plain text so the
    // user still gets the message instead of silence. (See htmlToPlainText.)
    logError(`sendMessage rejected for bad HTML entities — resending as plain text: ${err.message}`)
    const { parse_mode, ...plain } = body
    plain.text = htmlToPlainText(text)
    return tg('sendMessage', plain)
  }
}

async function editMessageText(messageId, text, opts = {}) {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: opts.parseMode || 'HTML',
    ...opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {},
  }
  try {
    return await tg('editMessageText', body)
  } catch (err) {
    if (!isParseEntitiesError(err)) throw err
    logError(`editMessageText rejected for bad HTML entities — resending as plain text: ${err.message}`)
    const { parse_mode, ...plain } = body
    plain.text = htmlToPlainText(text)
    return tg('editMessageText', plain)
  }
}

async function sendTypingAction() {
  if (!chatId) return
  // Fire-and-forget with short timeout — don't use tg() retry wrapper
  // because retry delays make the typing indicator appear slow.
  // On failure, retry once immediately to maximize indicator visibility.
  const doSend = () => fetch(`${TELEGRAM_API}${botToken}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    signal: AbortSignal.timeout(5000),
  })
  try {
    doSend().then(r => r.json()).then(j => {
      if (!j.ok) doSend().catch(() => {})
    }).catch(() => {
      doSend().catch(() => {})
    })
  } catch {
    // non-critical
  }
}

async function answerCallbackQuery(callbackQueryId, text) {
  try {
    await tg('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text || '',
    })
  } catch {
    // non-critical
  }
}

// --- Typing indicator ---

function startTyping() {
  if (typingInterval) return
  waitingForReply = true
  sendTypingAction()
  typingInterval = setInterval(sendTypingAction, TYPING_INTERVAL)
}

function stopTyping() {
  waitingForReply = false
  if (typingInterval) {
    clearInterval(typingInterval)
    typingInterval = null
  }
}

// --- PID file ---

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function checkPidFile() {
  if (!existsSync(PID_FILE)) return
  try {
    const content = await readFile(PID_FILE, 'utf-8')
    const pid = parseInt(content.trim(), 10)
    if (isNaN(pid)) return
    if (pid === process.pid) return
    if (isProcessRunning(pid)) {
      logError(`Another instance is already running (pid=${pid}). Exiting.`)
      process.exit(1)
    }
    log(`Stale PID file found (pid=${pid} not running). Overwriting.`)
  } catch {
    // Can't read PID file — proceed
  }
}

async function writePidFile() {
  await writeFile(PID_FILE, String(process.pid), 'utf-8')
}

async function removePidFile() {
  try {
    if (existsSync(PID_FILE)) await unlink(PID_FILE)
  } catch { /* ignore */ }
}

// --- Persistence ---

async function loadLastSentCount() {
  try {
    const val = await readFile(LAST_SENT_FILE, 'utf-8')
    const n = parseInt(val.trim(), 10)
    return isNaN(n) ? 0 : n
  } catch {
    return 0
  }
}

async function saveLastSentCount(n) {
  await writeFile(LAST_SENT_FILE, String(n), 'utf-8')
}

async function loadLastUpdateId() {
  try {
    const val = await readFile(LAST_UPDATE_ID_FILE, 'utf-8')
    const n = parseInt(val.trim(), 10)
    return isNaN(n) ? -1 : n
  } catch {
    return -1
  }
}

async function saveLastUpdateId(id) {
  await writeFile(LAST_UPDATE_ID_FILE, String(id), 'utf-8')
}

async function loadSentEscalations() {
  const data = await readJsonFile(SENT_ESCALATIONS_FILE)
  return new Set(Array.isArray(data) ? data : [])
}

async function saveSentEscalations() {
  await writeJsonFile(SENT_ESCALATIONS_FILE, [...sentEscalationIds])
}

async function loadMessageMap() {
  const data = await readJsonFile(MESSAGE_MAP_FILE)
  if (data && typeof data === 'object') {
    if (data.lastUserMessageId) lastUserMessageId = data.lastUserMessageId
    if (typeof data.lastUserMessageAt === 'number') lastUserMessageAt = data.lastUserMessageAt
    if (Array.isArray(data._userMessageAnchors)) userMessageAnchors = data._userMessageAnchors
    return data
  }
  return {}
}

async function saveMessageMap() {
  // Prune old entries to keep the map bounded
  const keys = Object.keys(messageMap).filter(k => k !== 'lastUserMessageId' && k !== 'lastUserMessageAt' && k !== '_userMessageAnchors')
  if (keys.length > MAX_MESSAGE_MAP_SIZE) {
    // Keep only the most recent entries (highest numeric keys)
    const numericKeys = keys.filter(k => !isNaN(parseInt(k, 10))).map(Number).sort((a, b) => a - b)
    const toRemove = numericKeys.slice(0, numericKeys.length - MAX_MESSAGE_MAP_SIZE)
    for (const k of toRemove) {
      delete messageMap[String(k)]
    }
  }
  // Prune old anchors
  if (userMessageAnchors.length > MAX_ANCHORS) {
    userMessageAnchors = userMessageAnchors.slice(-MAX_ANCHORS)
  }
  messageMap.lastUserMessageId = lastUserMessageId
  messageMap.lastUserMessageAt = lastUserMessageAt
  messageMap._userMessageAnchors = userMessageAnchors
  await writeJsonFile(MESSAGE_MAP_FILE, messageMap)
}

// --- Message processing ---

// Build reply context string when user replies to a bot message
function buildReplyContext(replyToMessage) {
  if (!replyToMessage) return ''
  const replyText = replyToMessage.text || replyToMessage.caption || ''
  if (!replyText.trim()) return ''
  // Truncate long quoted text
  const maxQuoteLen = 200
  const quoted = replyText.length > maxQuoteLen
    ? replyText.slice(0, maxQuoteLen - 3) + '...'
    : replyText
  return `[Replying to: "${quoted}"]\n\n`
}

async function handleTextMessage(text, msg) {
  // Check if this is a freeform reply to an escalation card
  if (msg?.reply_to_message?.message_id && escalationMessageMap.has(msg.reply_to_message.message_id)) {
    const escId = escalationMessageMap.get(msg.reply_to_message.message_id)
    const escFile = join(ESCALATIONS_DIR, `${escId}.json`)
    if (existsSync(escFile)) {
      log(`Freeform escalation reply for ${escId}: ${text.slice(0, 100)}`)
      try {
        await new Promise((resolve, reject) => {
          execFile('bash', [
            join(SUPERBOT_DIR, 'scripts', 'resolve-escalation.sh'),
            escFile,
            '--resolution', text.trim(),
            '--resolved-by', 'user',
          ], { timeout: 10000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message))
            else resolve(stdout)
          })
        })
        // Edit the escalation card to show resolved state
        try {
          const origMsg = msg.reply_to_message
          await editMessageText(origMsg.message_id,
            (origMsg.text || '') + `\n\n✅ <b>Resolved:</b> ${escapeHtml(text.trim())}`,
            { replyMarkup: { inline_keyboard: [] } }
          )
        } catch { /* ignore edit failures */ }
        await sendMessage('Escalation resolved.', { replyToMessageId: msg.message_id })
        escalationMessageMap.delete(msg.reply_to_message.message_id)
      } catch (err) {
        logError(`Failed to resolve escalation ${escId} via freeform reply: ${err.message}`)
        await sendMessage('Failed to resolve escalation.')
      }
      return
    } else {
      log(`Escalation file not found for freeform reply: ${escFile} (may already be resolved)`)
      escalationMessageMap.delete(msg.reply_to_message.message_id)
    }
  }

  // Check for bot commands
  const cmd = text.trim().toLowerCase()

  // Bot commands — typing indicator will naturally expire (Telegram 5s window)
  // and stopTyping() is only called when an orchestrator reply is delivered
  if (cmd === '/start') {
    await sendMessage(
      '<b>superbot2 Telegram Bot</b>\n\n' +
      'Connected! Your chat ID has been registered.\n\n' +
      'Send me a message and I\'ll relay it to the orchestrator.\n\n' +
      'Commands:\n' +
      '/status - Portfolio overview\n' +
      '/spaces - Spaces and project details\n' +
      '/escalations - Open escalations needing your input\n' +
      '/workers - Active team members\n' +
      '/recent - Recent session summaries\n' +
      '/schedule - Scheduled jobs\n' +
      '/todo - Your todos\n' +
      '/help - List commands'
    )
    return
  }

  if (cmd === '/help') {
    await sendMessage(
      '<b>Available Commands</b>\n\n' +
      '/status - Portfolio overview (spaces, projects, tasks)\n' +
      '/spaces - Spaces and project details\n' +
      '/escalations - List open escalations with action buttons\n' +
      '/workers - Active team members\n' +
      '/recent - Recent session summaries\n' +
      '/schedule - Scheduled jobs\n' +
      '/todo - Your todos\n' +
      '/help - Show this message\n\n' +
      'Any other message is sent to the superbot2 orchestrator.'
    )
    return
  }

  if (cmd === '/status') {
    await handleStatusCommand()
    return
  }

  if (cmd === '/escalations') {
    await handleEscalationsCommand()
    return
  }

  if (cmd === '/workers') {
    await handleWorkersCommand()
    return
  }

  if (cmd === '/recent') {
    await handleRecentActivityCommand()
    return
  }

  if (cmd === '/schedule') {
    await handleScheduleCommand()
    return
  }

  if (cmd === '/todo') {
    await handleTodosCommand()
    return
  }

  if (cmd === '/spaces') {
    await handleSpacesCommand()
    return
  }

  // Regular message — relay to orchestrator
  // Track the user's message ID for reply threading (with receive time for the
  // threading freshness gate).
  if (msg && msg.message_id) {
    lastUserMessageId = msg.message_id
    lastUserMessageAt = Date.now()
  }

  // Activate Telegram conversation — set baseline to lastSentReplyCount so we
  // forward any replies that haven't been sent yet, including ones that arrived
  // between the user's message and now (race condition fix).
  replyBaseline = lastSentReplyCount
  try {
    const dashUserInbox = await readJsonFile(join(TEAM_INBOXES_DIR, 'dashboard-user.json')) || []
    const orchestratorReplies = dashUserInbox.filter(m => m.from === 'team-lead')
    if (msg && msg.message_id) {
      userMessageAnchors.push({
        inboxCountAtSend: orchestratorReplies.length,
        telegramMessageId: msg.message_id,
        at: Date.now(),
      })
    }
  } catch {
    replyBaseline = lastSentReplyCount
    if (msg && msg.message_id) {
      userMessageAnchors.push({
        inboxCountAtSend: lastSentReplyCount,
        telegramMessageId: msg.message_id,
        at: Date.now(),
      })
    }
  }
  await saveMessageMap()

  // Build the relayed text, prepending reply context if the user replied to a specific message
  const replyContext = msg?.reply_to_message ? buildReplyContext(msg.reply_to_message) : ''
  const relayText = replyContext + text

  startTyping()
  try {
    const res = await fetch(`${DASHBOARD_API}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: relayText }),
    })
    if (!res.ok) {
      logError(`Failed to relay message to dashboard: HTTP ${res.status}`)
      await sendMessage('Failed to relay message to orchestrator.')
    } else {
      log(`Relayed message to orchestrator: ${relayText.slice(0, 80)}...`)
    }
  } catch (err) {
    logError(`Error relaying message: ${err.message}`)
    await sendMessage('Failed to relay message — is the dashboard running?')
  }
}

async function handleStatusCommand() {
  await sendTypingAction()
  const scriptsDir = join(SUPERBOT_DIR, 'scripts')
  const statusScript = join(scriptsDir, 'portfolio-status.sh')

  try {
    const output = await new Promise((resolve, reject) => {
      execFile('bash', [statusScript, '--compact'], { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message))
        else resolve(stdout)
      })
    })

    const formatted = output.trim() || 'No spaces found.'
    await sendMessage(`<b>Portfolio Status</b>\n\n<pre>${escapeHtml(formatted)}</pre>`)
  } catch (err) {
    logError(`Status command failed: ${err.message}`)
    await sendMessage('Failed to get portfolio status.')
  }
}

async function handleEscalationsCommand() {
  await sendTypingAction()

  try {
    if (!existsSync(ESCALATIONS_DIR)) {
      await sendMessage('No open escalations.')
      return
    }

    const files = await readdir(ESCALATIONS_DIR)
    const jsonFiles = files.filter(f => f.endsWith('.json'))

    if (jsonFiles.length === 0) {
      await sendMessage('No open escalations.')
      return
    }

    for (const file of jsonFiles) {
      const esc = await readJsonFile(join(ESCALATIONS_DIR, file))
      if (!esc) continue
      await sendEscalationCard(esc)
    }
  } catch (err) {
    logError(`Escalations command failed: ${err.message}`)
    await sendMessage('Failed to list escalations.')
  }
}

async function handleRecentActivityCommand() {
  await sendTypingAction()

  try {
    const sessionsDir = join(SUPERBOT_DIR, 'sessions')
    if (!existsSync(sessionsDir)) {
      await sendMessage('No recent activity.')
      return
    }

    const files = await readdir(sessionsDir)
    const jsonFiles = files.filter(f => f.endsWith('.json')).sort().reverse().slice(0, 10)

    if (jsonFiles.length === 0) {
      await sendMessage('No recent activity.')
      return
    }

    let text = '<b>Recent Activity</b>\n'

    for (const file of jsonFiles) {
      const session = await readJsonFile(join(sessionsDir, file))
      if (!session) continue

      const ts = session.completedAt || session.id?.replace('session-', '') || '?'
      const spaceProject = `${session.space || '?'}/${session.project || '?'}`
      const worker = session.worker || '?'
      const summary = session.summary || 'No summary'

      // Truncate long summaries
      const shortSummary = summary.length > 200 ? summary.slice(0, 197) + '...' : summary

      text += `\n<b>${escapeHtml(spaceProject)}</b>\n`
      text += `<i>${escapeHtml(ts)}</i>\n`
      text += `Worker: <code>${escapeHtml(worker)}</code>\n`
      text += `${escapeHtml(shortSummary)}\n`
    }

    // Truncate if over Telegram limit
    if (text.length > 4000) {
      text = text.slice(0, 3997) + '...'
    }

    await sendMessage(text)
  } catch (err) {
    logError(`Recent activity command failed: ${err.message}`)
    await sendMessage('Failed to get recent activity.')
  }
}

async function handleScheduleCommand() {
  await sendTypingAction()

  try {
    const config = await readJsonFile(CONFIG_PATH)
    const schedule = config?.schedule

    if (!schedule || !Array.isArray(schedule) || schedule.length === 0) {
      await sendMessage('No scheduled jobs.')
      return
    }

    let text = '<b>Scheduled Jobs</b>\n'

    for (const job of schedule) {
      const name = job.name || '?'
      const time = job.time || '?'
      const space = job.space || '?'
      const task = job.task || 'No description'

      // Truncate long task descriptions
      const shortTask = task.length > 150 ? task.slice(0, 147) + '...' : task

      text += `\n<b>${escapeHtml(name)}</b>\n`
      text += `Schedule: <code>${escapeHtml(time)}</code> | Space: <code>${escapeHtml(space)}</code>\n`
      text += `${escapeHtml(shortTask)}\n`
    }

    if (text.length > 4000) {
      text = text.slice(0, 3997) + '...'
    }

    await sendMessage(text)
  } catch (err) {
    logError(`Schedule command failed: ${err.message}`)
    await sendMessage('Failed to get schedule.')
  }
}

async function handleTodosCommand() {
  await sendTypingAction()

  try {
    const todosPath = join(SUPERBOT_DIR, 'todos.json')
    const todos = await readJsonFile(todosPath)

    if (!todos || !Array.isArray(todos) || todos.length === 0) {
      await sendMessage('No todos yet.')
      return
    }

    let text = '<b>Todos</b>\n'

    for (const todo of todos) {
      const title = todo.title || todo.subject || '?'
      const status = todo.status || '?'
      const notes = todo.notes || ''

      const statusIcon = status === 'completed' ? '✅' : status === 'in_progress' ? '🔄' : '⬜'

      text += `\n${statusIcon} <b>${escapeHtml(title)}</b>`
      text += ` <i>(${escapeHtml(status)})</i>\n`
      if (notes) {
        const shortNotes = notes.length > 100 ? notes.slice(0, 97) + '...' : notes
        text += `${escapeHtml(shortNotes)}\n`
      }
    }

    if (text.length > 4000) {
      text = text.slice(0, 3997) + '...'
    }

    await sendMessage(text)
  } catch (err) {
    logError(`Todos command failed: ${err.message}`)
    await sendMessage('Failed to get todos.')
  }
}

async function handleSpacesCommand() {
  await sendTypingAction()

  try {
    if (!existsSync(SPACES_DIR)) {
      await sendMessage('No spaces found.')
      return
    }

    const spaceDirs = await readdir(SPACES_DIR)
    if (spaceDirs.length === 0) {
      await sendMessage('No spaces found.')
      return
    }

    let text = '<b>Spaces</b>\n'

    for (const spaceSlug of spaceDirs.sort()) {
      const spaceDir = join(SPACES_DIR, spaceSlug)
      const spaceJson = await readJsonFile(join(spaceDir, 'space.json'))
      if (!spaceJson) continue

      const name = spaceJson.name || spaceSlug
      const status = spaceJson.status || 'unknown'
      const description = spaceJson.description || ''

      text += `\n<b>${escapeHtml(name)}</b>`
      text += ` <i>(${escapeHtml(status)})</i>\n`
      if (description) {
        text += `${escapeHtml(description)}\n`
      }

      // List projects under plans/
      const plansDir = join(spaceDir, 'plans')
      let projects = []
      try {
        if (existsSync(plansDir)) {
          projects = await readdir(plansDir)
          // Filter to directories that contain a tasks/ folder or plan.md
          const validProjects = []
          for (const p of projects.sort()) {
            const tasksDir = join(plansDir, p, 'tasks')
            const planFile = join(plansDir, p, 'plan.md')
            if (existsSync(tasksDir) || existsSync(planFile)) {
              validProjects.push(p)
            }
          }
          projects = validProjects
        }
      } catch {
        projects = []
      }

      if (projects.length === 0) {
        text += '  No projects\n'
        continue
      }

      for (const project of projects) {
        const tasksDir = join(plansDir, project, 'tasks')
        let totalTasks = 0
        let completedTasks = 0

        try {
          if (existsSync(tasksDir)) {
            const taskFiles = (await readdir(tasksDir)).filter(f => f.endsWith('.json'))
            for (const tf of taskFiles) {
              const task = await readJsonFile(join(tasksDir, tf))
              if (!task) continue
              totalTasks++
              if (task.status === 'completed') completedTasks++
            }
          }
        } catch {
          // ignore task read errors
        }

        const taskInfo = totalTasks > 0
          ? `${completedTasks}/${totalTasks} tasks done`
          : 'no tasks'

        text += `  <code>${escapeHtml(project)}</code> — ${taskInfo}\n`
      }
    }

    if (text.length > 4000) {
      text = text.slice(0, 3997) + '...'
    }

    await sendMessage(text)
  } catch (err) {
    logError(`Spaces command failed: ${err.message}`)
    await sendMessage('Failed to list spaces.')
  }
}

async function handleWorkersCommand() {
  await sendTypingAction()

  try {
    // Derive the team config from the active inbox dir (teams/<team>/inboxes ->
    // teams/<team>/config.json) so /workers tracks the live session, not a fixed name.
    await refreshActiveInbox()
    const teamConfigPath = join(TEAM_INBOXES_DIR, '..', 'config.json')
    const teamConfig = await readJsonFile(teamConfigPath)

    if (!teamConfig?.members || teamConfig.members.length === 0) {
      await sendMessage('No team members found.')
      return
    }

    let text = '<b>Team Members</b>\n'

    for (const member of teamConfig.members) {
      const name = member.name || '?'
      const type = member.agentType || '?'
      const model = member.model || '?'
      const cwd = member.cwd || ''

      // Derive a short workspace name from cwd
      const workspace = cwd ? basename(cwd) : ''

      text += `\n<b>${escapeHtml(name)}</b>`
      text += ` <i>(${escapeHtml(type)})</i>\n`
      text += `Model: <code>${escapeHtml(model)}</code>`
      if (workspace) text += ` | Dir: <code>${escapeHtml(workspace)}</code>`
      text += '\n'
    }

    if (text.length > 4000) {
      text = text.slice(0, 3997) + '...'
    }

    await sendMessage(text)
  } catch (err) {
    logError(`Workers command failed: ${err.message}`)
    await sendMessage('Failed to list workers.')
  }
}

// --- Escalation cards ---

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Telegram rejects an ENTIRE message with 400 "can't parse entities" when the
// HTML we built (via markdownToTelegramHtml) has mismatched/overlapping tags —
// e.g. interleaved <b>/<i> from overlapping markdown. That error is NOT
// retryable (it fails identically every time), so without a fallback the reply
// is silently dropped and the user sees no response. htmlToPlainText converts
// our HTML back to readable plain text so a failed formatted send can be resent
// WITHOUT parse_mode and still deliver the content (formatting lost, message not).
function htmlToPlainText(text) {
  return text
    .replace(/<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|span|tg-spoiler)(?:\s[^>]*)?>/gi, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&') // must be last so earlier entities don't double-decode
}

function isParseEntitiesError(err) {
  return (err?.message || '').toLowerCase().includes("can't parse entities")
}

// Convert standard markdown (from orchestrator) to Telegram-safe HTML.
// Escapes HTML entities first, then converts markdown syntax to HTML tags.
function markdownToTelegramHtml(text) {
  // Step 1: Escape HTML entities
  let out = escapeHtml(text)

  // Step 2: Convert fenced code blocks (```...```) to <pre>
  out = out.replace(/```(?:\w*)\n?([\s\S]*?)```/g, '<pre>$1</pre>')

  // Step 3: Convert inline code (`...`) to <code>
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>')

  // Step 4: Convert bold (**...**) to <b>
  out = out.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')

  // Step 5: Convert italic (*...*) to <i> — single asterisks not preceded/followed by *
  out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')

  // Step 6: Convert markdown links [text](url) to <a href="url">text</a>
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  return out
}

function priorityBadge(priority) {
  switch (priority) {
    case 'critical': return '🔴 CRITICAL'
    case 'high': return '🟠 HIGH'
    case 'medium': return '🟡 MEDIUM'
    case 'low': return '🟢 LOW'
    default: return priority?.toUpperCase() || ''
  }
}

async function sendEscalationCard(esc) {
  const title = esc.question || esc.subject || 'Escalation'
  const badge = priorityBadge(esc.priority)
  const space = esc.space || '?'
  const project = esc.project || '?'
  const context = esc.context || ''

  let text = `<b>${escapeHtml(title)}</b>\n`
  text += `${badge} | ${escapeHtml(space)}/${escapeHtml(project)}\n\n`
  if (context) {
    text += `<blockquote>${escapeHtml(context)}</blockquote>\n`
  }

  // Build inline keyboard with short callback_data keys (Telegram limit: 64 bytes)
  // We register a per-escalation counter so all buttons for one escalation share the same counter
  callbackCounter++
  const escCounter = callbackCounter
  const buttons = []
  if (esc.suggestedAnswers && esc.suggestedAnswers.length > 0) {
    for (let i = 0; i < esc.suggestedAnswers.length; i++) {
      const answer = esc.suggestedAnswers[i]
      const label = answer.label || answer.description || `Option ${i + 1}`
      const shortKey = `e${escCounter}:${i}`
      callbackMap.set(shortKey, esc.id)
      buttons.push([{
        text: label,
        callback_data: shortKey,
      }])
    }
  }

  const replyMarkup = { inline_keyboard: buttons }

  try {
    const sentMsg = await sendMessage(text, { replyMarkup })
    if (sentMsg?.message_id) {
      escalationMessageMap.set(sentMsg.message_id, esc.id)
    }
    log(`Sent escalation card for ${esc.id}`)
  } catch (err) {
    logError(`Failed to send escalation card for ${esc.id}: ${err.message}`)
  }
}

async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery.data || ''
  const callbackId = callbackQuery.id
  const message = callbackQuery.message

  // Callback data format: "e<N>:<answerIdx>" — look up full escalation ID from in-memory map
  if (!data.startsWith('e')) {
    await answerCallbackQuery(callbackId, 'Unknown action')
    return
  }

  const escId = callbackMap.get(data)
  if (!escId) {
    log(`Callback key not found in map: ${data} (bot may have restarted since card was sent)`)
    await answerCallbackQuery(callbackId, 'Session expired — use /escalations to refresh')
    return
  }

  const parts = data.split(':')
  const answerIdx = parseInt(parts[1], 10)

  // Read the escalation to get the answer text
  const escFile = join(ESCALATIONS_DIR, `${escId}.json`)
  let esc = await readJsonFile(escFile)

  // If not in needs_human, try to find it (might have been moved already)
  if (!esc) {
    // Check resolved
    const resolvedFile = join(SUPERBOT_DIR, 'escalations', 'resolved', `${escId}.json`)
    esc = await readJsonFile(resolvedFile)
    if (esc) {
      await answerCallbackQuery(callbackId, 'Already resolved')
      // Update the message to show resolved state
      if (message) {
        try {
          await editMessageText(message.message_id,
            message.text + '\n\n✅ <b>Already resolved</b>',
            { replyMarkup: { inline_keyboard: [] } }
          )
        } catch { /* ignore edit failures */ }
      }
      return
    }
    await answerCallbackQuery(callbackId, 'Escalation not found')
    return
  }

  const answer = esc.suggestedAnswers?.[answerIdx]
  const resolution = answer?.label || answer?.description || `Option ${answerIdx + 1}`

  // Resolve via dashboard API
  try {
    const res = await fetch(`${DASHBOARD_API}/escalations/${encodeURIComponent(escId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution }),
    })

    if (!res.ok) {
      const errBody = await res.text()
      logError(`Failed to resolve escalation ${escId}: HTTP ${res.status} - ${errBody}`)
      await answerCallbackQuery(callbackId, 'Failed to resolve')
      return
    }

    log(`Resolved escalation ${escId}: ${resolution}`)
    await answerCallbackQuery(callbackId, 'Resolved!')

    // Edit the message in place to show resolved state
    if (message) {
      try {
        // Reconstruct text without HTML to avoid parse issues on edit
        const title = esc.question || esc.subject || 'Escalation'
        const badge = priorityBadge(esc.priority)
        const space = esc.space || '?'
        const project = esc.project || '?'

        let newText = `<b>${escapeHtml(title)}</b>\n`
        newText += `${badge} | ${escapeHtml(space)}/${escapeHtml(project)}\n\n`
        newText += `✅ <b>Resolved:</b> ${escapeHtml(resolution)}`

        await editMessageText(message.message_id, newText, {
          replyMarkup: { inline_keyboard: [] },
        })
      } catch (editErr) {
        logError(`Failed to edit message after resolve: ${editErr.message}`)
      }
    }
  } catch (err) {
    logError(`Error resolving escalation ${escId}: ${err.message}`)
    await answerCallbackQuery(callbackId, 'Error resolving')
  }
}

// --- Smart typing detection ---
// If an orchestrator reply mentions spawning a worker or background task,
// stop the typing indicator — the user shouldn't see typing during a long background wait.
const BACKGROUND_TASK_PATTERNS = [
  /\bspawn(ing|ed)?\b.*\bworker\b/i,
  /\bdispatch(ing|ed)?\b.*\bworker\b/i,
  /\bbackground\s+task\b/i,
  /\bworker\s+(started|launched|dispatched|spawned)\b/i,
  /\bkicking off\b.*\bworker\b/i,
  /\bstarting\b.*\bworker\b/i,
  /\bqueued\b.*\b(task|work)\b/i,
]

function mentionsBackgroundWork(text) {
  return BACKGROUND_TASK_PATTERNS.some(p => p.test(text))
}

// --- Reply mirroring ---

// Helper: send a new text reply with HTML -> plain text -> no-threading fallback chain
async function sendNewTextReply(html, plainText, replyToId) {
  try {
    const result = await tg('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      ...(replyToId ? { reply_to_message_id: replyToId, allow_sending_without_reply: true } : {}),
    })
    log(`Sent reply to Telegram (reply_to=${replyToId || 'none'}): ${plainText.slice(0, 60)}...`)
    if (result?.message_id) {
      lastSentBotMessageId = result.message_id
      lastSentBotMessageTime = Date.now()
      lastSentBotMessageText = plainText
    }
    return result
  } catch (err) {
    logError(`Failed to send reply to Telegram: ${err.message}`)
    try {
      const result = await tg('sendMessage', {
        chat_id: chatId,
        text: plainText,
        ...(replyToId ? { reply_to_message_id: replyToId, allow_sending_without_reply: true } : {}),
      })
      log(`Sent reply as plain text fallback`)
      if (result?.message_id) {
        lastSentBotMessageId = result.message_id
        lastSentBotMessageTime = Date.now()
        lastSentBotMessageText = plainText
      }
      return result
    } catch (fallbackErr) {
      logError(`Fallback send also failed: ${fallbackErr.message}`)
      try {
        await tg('sendMessage', { chat_id: chatId, text: plainText })
      } catch { /* give up */ }
      return null
    }
  }
}

async function writeOutboundHeartbeat() {
  // Proves the outbound relay loop is alive, independent of the inbound poll loop.
  // The watchdog watches this file; staleness => the loop wedged => restart.
  await writeFile(OUTBOUND_HEARTBEAT_FILE, String(Date.now()), 'utf-8').catch(() => {})
}

async function checkForReplies() {
  // Re-entrancy guard: never let two cycles overlap (setInterval doesn't await).
  if (replyCheckRunning) return
  replyCheckRunning = true

  // outboundStuck: true when this cycle ends with a reply we FAILED to deliver.
  // The outbound heartbeat must reflect "outbound is HEALTHY", not merely "the loop
  // cycled" — otherwise a watcher that keeps looping but can't send (network wedge:
  // fetch timeouts every cycle) refreshes the heartbeat forever and the watchdog's
  // outbound-staleness check never fires. That is exactly the silent ~30-min outage on
  // 2026-07-13 (the orchestrator had to manually restart the watcher). When stuck, we
  // SKIP the heartbeat write so it goes stale and the watchdog restarts a fresh watcher
  // (which retries from the same counter — nothing is dropped). A one-off transient
  // failure just skips one write; only a stall persisting past the watchdog threshold
  // (~180s) triggers a restart.
  let outboundStuck = false

  if (!chatId) {
    // Loop is alive even without a chatId — record liveness and bail.
    replyCheckRunning = false
    await writeOutboundHeartbeat()
    return
  }

  try {
    // Re-resolve the active team inbox each cycle so a mid-run orchestrator session
    // change (new session-named team) is picked up without a restart. On a path SWITCH
    // this resets the outbound counter to 0 (see refreshActiveInbox) so we forward the
    // new inbox once and never double-send across the switch.
    await refreshActiveInbox()

    const dashUserInbox = await readJsonFile(join(TEAM_INBOXES_DIR, 'dashboard-user.json')) || []
    const orchestratorReplies = dashUserInbox.filter(m => m.from === 'team-lead')

    // Safety: if the inbox was truncated/recreated (e.g. orchestrator restart),
    // our counter may be too high. Reset to 0 so all messages in the new inbox
    // get forwarded — the old messages are gone, these are all new.
    if (lastSentReplyCount > orchestratorReplies.length) {
      log(`Inbox truncated: counter was ${lastSentReplyCount}, inbox now has ${orchestratorReplies.length} replies — resetting to 0`)
      lastSentReplyCount = 0
      // A truncated inbox means a NEW orchestrator session on the same team path —
      // anchor inboxCountAtSend values refer to the old inbox and would mis-thread.
      userMessageAnchors = []
      await saveLastSentCount(lastSentReplyCount)
      await saveMessageMap()
    }

    // Always forward unsent replies — no conversation gating.
    // The counter ensures we never send duplicates, and the replyBaseline
    // prevents dumping old messages after a restart.
    const startIdx = Math.max(lastSentReplyCount, replyBaseline)

    if (orchestratorReplies.length <= startIdx) {
      return
    }

    const newReplies = orchestratorReplies.slice(startIdx)

    for (const reply of newReplies) {
     // Track the inbox index for this reply (for future reverse-mapping)
     const replyIdx = startIdx + newReplies.indexOf(reply)
     // delivered: true only when this reply was actually relayed (or had nothing
     // to relay). We advance + persist the counter PER reply on success, and BREAK
     // on a delivery failure, so the next cycle — or a fresh instance after a
     // restart — resumes from exactly this reply. Nothing is ever skipped/dropped.
     let delivered = false
     let editSucceeded = false
     let overflowOk = true // caption-overflow trailing text (image branch) delivered?
     let chosenAnchor = null // anchor this reply threads to; marked used on delivery
     try {
      const text = reply.text || reply.content || ''
      if (!text.trim()) {
        delivered = true // nothing to send — count as handled
      } else {

      // Find the correct user message to thread this reply to.
      // Walk anchors to find the one with the highest inboxCountAtSend that
      // is still <= replyIdx. When multiple anchors share the same
      // inboxCountAtSend (user sent rapid-fire messages before any reply),
      // pick the FIRST in that group — the earliest message that could have
      // triggered this reply. This prevents all replies from threading under
      // the user's most recent message when they sent several in a row.
      //
      // FRESHNESS GATE (2026-07-03 incident): only thread onto a target we can PROVE is
      // recent (has a timestamp within THREAD_MAX_AGE_MS). Legacy anchors without an
      // `at` timestamp, and anything older, are treated as stale — the reply is sent
      // UN-threaded instead, which is the mode that demonstrably delivers. A wrong or
      // ancient reply_to target buries the message for the user; no threading is
      // strictly better than stale threading.
      const nowMs = Date.now()
      const isFreshTs = (at) => typeof at === 'number' && at > 0 && (nowMs - at) <= THREAD_MAX_AGE_MS
      let replyToId = (lastUserMessageId && isFreshTs(lastUserMessageAt)) ? lastUserMessageId : null
      if (userMessageAnchors.length > 0) {
        // Group = fresh anchors sharing the HIGHEST inboxCountAtSend <= replyIdx.
        let bestCount = -1
        for (const anchor of userMessageAnchors) {
          if (!isFreshTs(anchor.at)) continue // stale/legacy anchor — never thread onto it
          if (anchor.inboxCountAtSend <= replyIdx && anchor.inboxCountAtSend > bestCount) {
            bestCount = anchor.inboxCountAtSend
          }
        }
        if (bestCount >= 0) {
          const group = userMessageAnchors.filter(a => isFreshTs(a.at) && a.inboxCountAtSend === bestCount)
          // Advance across rapid-fire messages: successive replies thread to successive
          // UNUSED anchors in arrival order, instead of every reply piling onto the
          // group's first message while later ones never get threaded (observed live
          // 2026-07-03: "Are you getting my messages?" was answered but both replies
          // threaded to the preceding "Test message 3:47pm"). Once every anchor in the
          // group has been used, stick with the LAST (most recent) — ongoing progress
          // updates keep threading to the message they follow from.
          chosenAnchor = group.find(a => !a.used) || group[group.length - 1]
          replyToId = chosenAnchor.telegramMessageId
        }
      }

      // Check for image paths in the message
      const imagePaths = extractImagePaths(text)
      const existingImages = imagePaths.length > 0 ? await filterExistingImages(imagePaths) : []

      let sentResult = null

      if (existingImages.length > 0) {
        // Send images with text as caption
        const textWithoutImages = stripImagePaths(text)
        const truncatedCaption = textWithoutImages.length > 1024
          ? textWithoutImages.slice(0, 1021) + '...'
          : textWithoutImages
        const captionHtml = truncatedCaption ? markdownToTelegramHtml(truncatedCaption) : ''

        try {
          if (existingImages.length === 1) {
            sentResult = await sendPhoto(existingImages[0], captionHtml, replyToId)
            log(`Sent photo to Telegram: ${basename(existingImages[0])}`)
          } else {
            // sendMediaGroup for 2-10 images (Telegram limit)
            const batch = existingImages.slice(0, 10)
            sentResult = await sendMediaGroup(batch, captionHtml, replyToId)
            log(`Sent ${batch.length} photos as album to Telegram`)
          }

          // If caption was truncated and there's significant remaining text, send the rest as a message.
          // Track its delivery: if the trailing chunk can't be sent, mark the whole reply
          // undelivered so it's retried (no silently-dropped text).
          if (textWithoutImages.length > 1024) {
            const remaining = textWithoutImages.slice(1024)
            const truncated = remaining.length > 4000 ? remaining.slice(0, 3997) + '...' : remaining
            const html = markdownToTelegramHtml(truncated)
            try {
              await tg('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML' })
            } catch {
              try {
                await tg('sendMessage', { chat_id: chatId, text: truncated })
              } catch {
                overflowOk = false
                logError('Caption-overflow text failed to send — reply will be retried')
              }
            }
          }
        } catch (err) {
          logError(`Failed to send photo(s) to Telegram: ${err.message}`)
          // Fallback: send as text with paths
          const truncated = text.length > 4000 ? text.slice(0, 3997) + '...' : text
          try {
            sentResult = await tg('sendMessage', {
              chat_id: chatId,
              text: markdownToTelegramHtml(truncated),
              parse_mode: 'HTML',
              ...(replyToId ? { reply_to_message_id: replyToId, allow_sending_without_reply: true } : {}),
            })
          } catch {
            await tg('sendMessage', { chat_id: chatId, text: truncated }).catch(() => {})
          }
        }
        // Reset edit tracking — can't edit a photo message into text
        lastSentBotMessageId = null
        lastSentBotMessageText = ''
      } else {
        // No images — send as text with reply threading
        const truncated = text.length > 4000 ? text.slice(0, 3997) + '...' : text
        const html = markdownToTelegramHtml(truncated)

        // Try to edit the previous message if it was sent recently (within 5s)
        const now = Date.now()
        const canEdit = lastSentBotMessageId &&
          (now - lastSentBotMessageTime) < EDIT_WINDOW_MS &&
          lastSentBotMessageText // don't edit if previous was empty

        if (canEdit) {
          // Append new text to previous message with a separator
          const combinedText = lastSentBotMessageText + '\n\n' + truncated
          const combinedTruncated = combinedText.length > 4000
            ? combinedText.slice(0, 3997) + '...'
            : combinedText
          const combinedHtml = markdownToTelegramHtml(combinedTruncated)

          try {
            await editMessageText(lastSentBotMessageId, combinedHtml)
            lastSentBotMessageText = combinedTruncated
            lastSentBotMessageTime = now
            // sentResult stays null — we reuse the existing message_id
            editSucceeded = true // delivered via edit, even though sentResult is null
            log(`Edited previous message to append reply`)
          } catch (editErr) {
            logError(`Failed to edit message, sending new: ${editErr.message}`)
            // Fall through to send as new message
            sentResult = await sendNewTextReply(html, truncated, replyToId)
          }
        } else {
          sentResult = await sendNewTextReply(html, truncated, replyToId)
        }
      }

      // sendMediaGroup returns an ARRAY of messages; normalize to the first for the map.
      const sentMsg = Array.isArray(sentResult) ? sentResult[0] : sentResult
      // Track the sent message ID so we can map it when user replies to it
      if (sentMsg?.message_id) {
        messageMap[String(replyIdx)] = sentMsg.message_id
      }
      // Delivered only if the primary send succeeded AND any caption-overflow text
      // also went through (or it was an edit-coalesce).
      delivered = (!!sentResult && overflowOk) || editSucceeded
      } // end else (non-empty text)
     } catch (replyErr) {
       // A THROWN error here is a logic/data problem, not a transient send failure
       // (sends have their own retry+fallback and return null instead of throwing).
       // Skip it so a single poison message can't wedge the loop forever.
       logError(`Error processing outbound reply idx ${replyIdx} — skipping: ${replyErr.message}`)
       delivered = true
     }

     if (delivered) {
       // Consume the anchor this reply threaded to, so the NEXT reply in a rapid-fire
       // group advances to the next message. (Persisted by the batch-end saveMessageMap.)
       if (chosenAnchor) chosenAnchor.used = true
       // Advance + persist immediately so the counter always reflects exactly what
       // has been relayed. A crash/kill/restart here resumes from the right offset.
       lastSentReplyCount = replyIdx + 1
       await saveLastSentCount(lastSentReplyCount)
     } else {
       // Transient delivery failure (network / Telegram down). Stop the batch and
       // retry from this exact reply next cycle — never advance past an undelivered
       // message, so a restart/handoff can't silently drop it.
       outboundStuck = true // don't refresh the outbound heartbeat: let the watchdog see the stall
       logError(`Outbound delivery failed for reply idx ${replyIdx} — will retry next cycle (no drop)`)
       break
     }
    }

    // Smart typing: if any reply mentions spawning a worker/background task,
    // stop typing and don't resume — the user shouldn't see typing during a long wait.
    const anyBackgroundWork = newReplies.some(r => mentionsBackgroundWork(r.text || r.content || ''))
    stopTyping()
    if (anyBackgroundWork) {
      waitingForReply = false
    }
    await saveMessageMap()
  } catch (err) {
    logError(`Error checking for replies: ${err.message}`)
  } finally {
    // Record outbound liveness — UNLESS a reply is stuck undelivered this cycle. A
    // completed cycle proves the loop isn't hung, but if we couldn't SEND, outbound is
    // not healthy; skipping the write lets the heartbeat go stale so the watchdog
    // restarts a fresh watcher (see outboundStuck above). Both a true hang (no cycle
    // completes) and a persistent send-stall now surface as a stale outbound heartbeat.
    if (!outboundStuck) await writeOutboundHeartbeat()
    replyCheckRunning = false
  }
}

// --- Escalation monitoring ---

async function checkForNewEscalations() {
  try {
    if (!existsSync(ESCALATIONS_DIR)) return

    const files = await readdir(ESCALATIONS_DIR)
    const jsonFiles = files.filter(f => f.endsWith('.json'))

    for (const file of jsonFiles) {
      const esc = await readJsonFile(join(ESCALATIONS_DIR, file))
      if (!esc || !esc.id) continue

      if (sentEscalationIds.has(esc.id)) continue

      // New escalation — send card
      log(`New escalation: ${esc.id}`)
      await sendEscalationCard(esc)
      sentEscalationIds.add(esc.id)
    }

    await saveSentEscalations()
  } catch (err) {
    logError(`Error checking escalations: ${err.message}`)
  }
}

// --- Long polling ---

async function pollUpdates() {
  // If no persisted offset, do a bootstrap poll with offset=-1 to skip old updates.
  // Telegram returns at most the latest update with offset=-1, which we use only to
  // set our lastUpdateId baseline.
  if (lastUpdateId < 0) {
    log('No persisted update offset — bootstrapping to skip old updates')
    try {
      const bootstrapRes = await fetch(`${TELEGRAM_API}${botToken}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset: -1, timeout: 0, allowed_updates: ['message', 'callback_query'] }),
        signal: AbortSignal.timeout(10000),
      })
      const bootstrapJson = await bootstrapRes.json()
      if (bootstrapJson.ok && bootstrapJson.result && bootstrapJson.result.length > 0) {
        const maxId = Math.max(...bootstrapJson.result.map(u => u.update_id))
        lastUpdateId = maxId
        await saveLastUpdateId(lastUpdateId)
        log(`Bootstrap: skipped old updates, offset set to ${lastUpdateId}`)
      } else {
        lastUpdateId = 0
        await saveLastUpdateId(lastUpdateId)
        log('Bootstrap: no pending updates, starting from 0')
      }
    } catch (err) {
      logError(`Bootstrap poll failed: ${err.message}`)
      lastUpdateId = 0
    }
  }

  log(`Polling for updates with offset=${lastUpdateId + 1}`)

  let consecutiveErrors = 0

  while (!shuttingDown) {
    try {
      const body = {
        offset: lastUpdateId + 1,
        timeout: POLL_TIMEOUT,
        allowed_updates: ['message', 'callback_query'],
      }

      const url = `${TELEGRAM_API}${botToken}/getUpdates`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout((POLL_TIMEOUT + 5) * 1000),
      })

      if (!res.ok) {
        let errText = ''
        try { errText = await res.text() } catch { errText = '(could not read response body)' }
        logError(`getUpdates failed: HTTP ${res.status} - ${errText}`)
        consecutiveErrors++
        await sleep(Math.min(5000 * Math.pow(2, consecutiveErrors - 1), 60000))
        continue
      }

      let json
      try {
        json = await res.json()
      } catch (parseErr) {
        logError(`getUpdates response not valid JSON: ${parseErr.message}`)
        consecutiveErrors++
        await sleep(Math.min(5000 * Math.pow(2, consecutiveErrors - 1), 60000))
        continue
      }

      if (!json.ok || !json.result) {
        logError(`getUpdates response not ok: ${JSON.stringify(json)}`)
        consecutiveErrors++
        await sleep(Math.min(5000 * Math.pow(2, consecutiveErrors - 1), 60000))
        continue
      }

      // Successful poll — reset error counter
      consecutiveErrors = 0

      for (const update of json.result) {
        try {
          lastUpdateId = Math.max(lastUpdateId, update.update_id)

          if (update.callback_query) {
            log(`Inbound callback_query [update_id=${update.update_id}]: data=${update.callback_query.data}`)
            await handleCallbackQuery(update.callback_query)
            continue
          }

          if (update.message) {
            const msg = update.message
            const msgChatId = String(msg.chat.id)

            // Auto-detect chatId from first message
            if (!chatId) {
              chatId = msgChatId
              await saveConfigField('chatId', chatId)
              log(`Auto-detected chatId: ${chatId}`)
              await sendMessage('Chat ID registered! You\'re connected to superbot2.')
            }

            // Security: only process messages from authorized chat
            if (msgChatId !== chatId) {
              log(`Ignoring message from unauthorized chat: ${msgChatId}`)
              continue
            }

            // Start typing immediately on any inbound message
            startTyping()

            if (msg.text) {
              const replyInfo = msg.reply_to_message ? ` (reply to msg ${msg.reply_to_message.message_id})` : ''
              log(`Inbound message [update_id=${update.update_id}, msg_id=${msg.message_id}]${replyInfo}: ${msg.text.slice(0, 100)}`)
              await handleTextMessage(msg.text, msg)
            } else if (msg.photo && msg.photo.length > 0) {
              // Telegram sends photos as array of sizes — pick the largest
              const photo = msg.photo[msg.photo.length - 1]
              log(`Inbound photo [update_id=${update.update_id}, msg_id=${msg.message_id}]: file_id=${photo.file_id}`)
              try {
                const localPath = await downloadTelegramFile(photo.file_id)
                // Relay as text message with the local path (and caption if any)
                const caption = msg.caption || ''
                const relayText = caption
                  ? `${caption}\n\n${localPath}`
                  : localPath
                await handleTextMessage(relayText, msg)
              } catch (dlErr) {
                logError(`Failed to download photo: ${dlErr.message}`)
                await sendMessage('Failed to download your photo.')
              }
            } else if (msg.document && msg.document.mime_type?.startsWith('image/')) {
              // Photos sent as files (uncompressed) also come as documents
              log(`Inbound image document [update_id=${update.update_id}, msg_id=${msg.message_id}]: file_id=${msg.document.file_id}`)
              try {
                const localPath = await downloadTelegramFile(msg.document.file_id)
                const caption = msg.caption || ''
                const relayText = caption
                  ? `${caption}\n\n${localPath}`
                  : localPath
                await handleTextMessage(relayText, msg)
              } catch (dlErr) {
                logError(`Failed to download image document: ${dlErr.message}`)
                await sendMessage('Failed to download your image.')
              }
            } else if (msg.document) {
              // Non-image documents (PDF, files, etc.)
              const doc = msg.document
              const docName = doc.file_name || 'unknown'
              log(`Inbound document [update_id=${update.update_id}, msg_id=${msg.message_id}]: ${docName} (${doc.mime_type || 'unknown type'}, file_id=${doc.file_id})`)
              try {
                const localPath = await downloadTelegramFile(doc.file_id)
                const caption = msg.caption || ''
                const relayText = caption
                  ? `${caption}\n\n[File: ${docName}]\n${localPath}`
                  : `[File: ${docName}]\n${localPath}`
                await handleTextMessage(relayText, msg)
              } catch (dlErr) {
                logError(`Failed to download document: ${dlErr.message}`)
                await sendMessage(`Failed to download your file (${docName}).`)
              }
            }
          }
        } catch (updateErr) {
          logError(`Error processing update ${update.update_id}: ${updateErr.message}`)
          // Continue processing remaining updates — don't let one bad update crash the loop
        }
      }

      // Persist offset after processing each batch
      if (json.result.length > 0) {
        await saveLastUpdateId(lastUpdateId)
      }

      // Write heartbeat so watchdog knows we're alive
      await writeFile(HEARTBEAT_FILE, String(Date.now()), 'utf-8')
    } catch (err) {
      if (shuttingDown) break
      // Write heartbeat even on errors — poll timeouts are normal and don't mean we're stuck
      await writeFile(HEARTBEAT_FILE, String(Date.now()), 'utf-8').catch(() => {})

      // Poll timeouts are normal (no messages arrived) — immediately re-poll, no backoff
      const isTimeout = err.name === 'TimeoutError' || err.message?.includes('timeout') || err.message?.includes('aborted')
      if (isTimeout) {
        continue
      }

      // Real errors get backoff
      consecutiveErrors++
      const backoff = Math.min(5000 * Math.pow(2, consecutiveErrors - 1), 60000)
      logError(`Polling error (consecutive=${consecutiveErrors}, backoff=${backoff}ms): ${err.message}`)
      await sleep(backoff)
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// --- Background loops ---

let replyCheckTimer = null
let escalationCheckTimer = null

function startBackgroundLoops() {
  replyCheckTimer = setInterval(checkForReplies, REPLY_POLL_INTERVAL)
  escalationCheckTimer = setInterval(checkForNewEscalations, ESCALATION_POLL_INTERVAL)
}

function stopBackgroundLoops() {
  if (replyCheckTimer) { clearInterval(replyCheckTimer); replyCheckTimer = null }
  if (escalationCheckTimer) { clearInterval(escalationCheckTimer); escalationCheckTimer = null }
}

// --- Main ---

async function main() {
  log('Starting...')

  // Load config
  const config = await loadConfig()
  if (!config) {
    logError('No telegram config found in config.json. Exiting.')
    process.exit(0)
  }

  if (!config.enabled) {
    log('Telegram not enabled. Exiting.')
    process.exit(0)
  }

  botToken = config.botToken
  if (!botToken) {
    logError('No botToken configured. Exiting.')
    process.exit(0)
  }

  chatId = config.chatId || ''

  // Load persisted state
  lastUpdateId = await loadLastUpdateId()
  lastSentReplyCount = await loadLastSentCount()
  sentEscalationIds = await loadSentEscalations()
  messageMap = await loadMessageMap()

  // Resolve the active team inbox at startup (before the truncation sync below) so the
  // counter sync runs against the inbox we'll actually read. This first resolution does
  // NOT trigger the switch-reset (activeInboxResolved starts false) — the loaded
  // lastSentReplyCount + the truncation check establish the correct baseline.
  await refreshActiveInbox()
  log(`Active team inbox resolved: ${TEAM_INBOXES_DIR}`)

  // Startup counter sync check — detect if inbox was truncated since last run.
  // Reset to 0 (not current length) because a truncated inbox means a new
  // orchestrator session — all messages in it are new and need forwarding.
  try {
    const dashUserInbox = await readJsonFile(join(TEAM_INBOXES_DIR, 'dashboard-user.json')) || []
    const orchestratorReplies = dashUserInbox.filter(m => m.from === 'team-lead')
    if (lastSentReplyCount > orchestratorReplies.length) {
      log(`Inbox truncated since last run: counter was ${lastSentReplyCount}, inbox now has ${orchestratorReplies.length} replies — resetting to 0`)
      lastSentReplyCount = 0
      // New session on the same team path — old anchors would mis-thread (see
      // checkForReplies truncation reset).
      userMessageAnchors = []
      await saveLastSentCount(lastSentReplyCount)
      await saveMessageMap()
    }
  } catch {
    // non-critical — will be caught in checkForReplies too
  }

  // Check for already-running instance, then write PID file
  await checkPidFile()
  await writePidFile()
  log(`PID file written: ${PID_FILE} (pid=${process.pid})`)

  // Verify bot token (retry up to 5 times for transient network issues)
  let connected = false
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const me = await tg('getMe', {})
      log(`Bot connected: @${me.username} (${me.first_name})`)
      connected = true
      break
    } catch (err) {
      logError(`Connection attempt ${attempt}/5 failed: ${err.message}`)
      if (attempt < 5) {
        await new Promise(r => setTimeout(r, 3000))
      }
    }
  }
  if (!connected) {
    logError('Failed to connect to Telegram after 5 attempts')
    await removePidFile()
    process.exit(1)
  }

  if (chatId) {
    log(`Authorized chatId: ${chatId}`)
  } else {
    log('No chatId configured — will auto-detect from first message')
  }

  // Register bot commands menu for autocomplete
  try {
    await tg('setMyCommands', {
      commands: [
        { command: 'status', description: 'Portfolio overview' },
        { command: 'escalations', description: 'Open escalations needing input' },
        { command: 'workers', description: 'Active workers' },
        { command: 'recent', description: 'Recent session summaries' },
        { command: 'schedule', description: 'Scheduled jobs' },
        { command: 'todo', description: 'Your todos' },
        { command: 'spaces', description: 'Spaces and project details' },
        { command: 'help', description: 'List available commands' },
      ],
    })
    log('Bot commands menu registered')
  } catch (err) {
    logError(`Failed to register bot commands: ${err.message}`)
    // Non-critical — commands still work, just no autocomplete
  }

  // Start background loops
  startBackgroundLoops()

  // Start long polling
  await pollUpdates()
}

// --- Shutdown ---

async function flushOutbound() {
  // Final drain before exit: relay any pending dashboard-user replies so a planned
  // restart (manual / watchdog / self-heal) doesn't leave a message un-sent. Safe to
  // call mid-cycle — we wait briefly for the re-entrancy guard to clear, then run one
  // last cycle. Combined with per-reply counter persistence, this means a restart
  // never silently drops a dashboard-user -> Telegram message.
  for (let i = 0; i < 50 && replyCheckRunning; i++) await sleep(100)
  await checkForReplies()
}

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  log(`Shutting down (${signal})... flushing pending outbound first`)
  stopTyping()
  stopBackgroundLoops()
  try {
    await Promise.race([
      flushOutbound(),
      sleep(GRACEFUL_FLUSH_TIMEOUT_MS).then(() => log('Outbound flush timed out — exiting anyway')),
    ])
  } catch (err) {
    logError(`Outbound flush error during shutdown: ${err.message}`)
  }
  await removePidFile()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

main().catch(err => {
  logError(`Fatal error: ${err.message}`)
  removePidFile().finally(() => process.exit(1))
})
