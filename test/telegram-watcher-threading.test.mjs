// Integration tests for OUTBOUND REPLY THREADING reliability (root-caused 2026-07-03).
//
// Incident: after an active-inbox SWITCH, the outbound counter resets to 0 but
// userMessageAnchors (inboxCountAtSend -> telegramMessageId) were NEVER cleared, so
// new-session replies threaded onto the PREVIOUS session's (stale) user messages
// (live log: reply_to=10737/10746/10752/10755 hours after those messages). A direct
// un-threaded send demonstrably delivered. Rules under test:
//   1. Anchors/lastUserMessageId without a fresh timestamp NEVER thread (legacy = stale).
//   2. An active-inbox switch CLEARS anchors (old-inbox indices are meaningless).
//   3. A genuinely fresh inbound user message still gets threaded replies, and every
//      threaded send carries allow_sending_without_reply so a bad target can never
//      degrade delivery.
//
// Runs the REAL telegram-watcher.mjs against a mock Telegram HTTP server (recording
// FULL request bodies) + a mock dashboard, with an isolated SUPERBOT2_HOME.
// Mirrors test/telegram-watcher-active-inbox.test.mjs (same spawn harness).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WATCHER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'telegram-watcher.mjs')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Mock Telegram API that records the FULL parsed body of every sendMessage, and can
// serve queued getUpdates batches (to simulate inbound user messages).
function startMockTelegram() {
  const state = { sent: [], updates: [] } // sent: [{text, reply_to_message_id, ...}]
  state.sentTexts = () => state.sent.map(b => b.text || '').join('\n')
  const server = createServer((req, res) => {
    const method = req.url.split('/').pop()
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const reply = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
      if (method === 'getMe') return reply({ ok: true, result: { username: 'mockbot', first_name: 'Mock' } })
      if (method === 'getUpdates') {
        const batch = state.updates.length ? [state.updates.shift()] : []
        return reply({ ok: true, result: batch })
      }
      if (method === 'setMyCommands') return reply({ ok: true, result: true })
      if (method === 'sendChatAction') return reply({ ok: true, result: true })
      if (method === 'editMessageText') {
        let parsed = {}; try { parsed = JSON.parse(body) } catch {}
        return reply({ ok: true, result: { message_id: parsed.message_id, text: parsed.text } })
      }
      if (method === 'sendMessage') {
        let parsed = {}; try { parsed = JSON.parse(body) } catch {}
        state.sent.push(parsed)
        return reply({ ok: true, result: { message_id: 5000 + state.sent.length, text: parsed.text } })
      }
      return reply({ ok: true, result: {} })
    })
  })
  return new Promise(r => server.listen(0, () => r({ server, state, port: server.address().port })))
}

// Mock dashboard: accepts the watcher's inbound relay POST /api/messages.
function startMockDashboard() {
  const state = { relayed: [] }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      if (req.url === '/api/messages' && req.method === 'POST') {
        try { state.relayed.push(JSON.parse(body)) } catch { state.relayed.push({}) }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  return new Promise(r => server.listen(0, () => r({ server, state, port: server.address().port })))
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'tg-thread-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    telegram: { enabled: true, botToken: 'test', chatId: '12345' },
  }))
  writeFileSync(join(home, 'telegram-last-update-id.txt'), '0')
  return home
}

function teamInboxDir(home, team) { return join(home, '.claude', 'teams', team, 'inboxes') }
function setTeamInbox(home, team, replies) {
  mkdirSync(teamInboxDir(home, team), { recursive: true })
  writeFileSync(
    join(teamInboxDir(home, team), 'dashboard-user.json'),
    JSON.stringify(replies.map(t => ({ from: 'team-lead', text: t }))),
  )
  writeFileSync(join(teamInboxDir(home, team), 'team-lead.json'), '[]')
}
function appendTeamInbox(home, team, text) {
  const f = join(teamInboxDir(home, team), 'dashboard-user.json')
  const a = JSON.parse(readFileSync(f, 'utf8'))
  a.push({ from: 'team-lead', text })
  writeFileSync(f, JSON.stringify(a))
}
function setDashMtime(home, team, epochSec) {
  utimesSync(join(teamInboxDir(home, team), 'dashboard-user.json'), epochSec, epochSec)
}
function writeMessageMap(home, map) {
  writeFileSync(join(home, 'telegram-message-map.json'), JSON.stringify(map))
}
function sentCount(home) {
  const f = join(home, 'telegram-last-sent-idx.txt')
  return existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0
}

function spawnWatcher(home, tgPort, dashPort, extraEnv = {}) {
  return spawn('node', [WATCHER], {
    env: {
      ...process.env,
      SUPERBOT2_HOME: home,
      TELEGRAM_API_BASE: `http://127.0.0.1:${tgPort}/bot`,
      SUPERBOT2_API_PORT: String(dashPort),
      TG_REPLY_POLL_INTERVAL: '400',
      SUPERBOT2_NAME: '',
      ...extraEnv,
    },
    stdio: 'ignore',
  })
}
async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) { if (await fn()) return true; await sleep(120) }
  return false
}
async function stop(proc) {
  if (!proc || proc.killed) return
  proc.kill('SIGKILL')
  await new Promise(r => proc.on('exit', r))
}

test('legacy (timestamp-less) anchors never thread: reply goes out UN-threaded', async () => {
  const { server, state, port } = await startMockTelegram()
  const { server: dash, port: dashPort } = await startMockDashboard()
  const home = makeHome()
  // Exactly the live incident state: persisted map has anchors from a PRIOR session
  // (inboxCountAtSend restarts at 0 after a switch) pointing at old Telegram messages.
  writeMessageMap(home, {
    lastUserMessageId: 10737,
    _userMessageAnchors: [
      { inboxCountAtSend: 0, telegramMessageId: 10737 },
      { inboxCountAtSend: 1, telegramMessageId: 10746 },
    ],
  })
  setTeamInbox(home, 'session-1', ['boot status reply'])
  const proc = spawnWatcher(home, port, dashPort)
  try {
    assert.ok(await waitFor(() => state.sent.length >= 1), 'reply should be delivered')
    const msg = state.sent.find(b => (b.text || '').includes('boot status reply'))
    assert.ok(msg, 'the inbox reply was sent')
    assert.equal(msg.reply_to_message_id, undefined,
      `must NOT thread onto a stale/legacy anchor (got reply_to=${msg.reply_to_message_id})`)
  } finally { await stop(proc); dash.close(); server.close() }
})

test('active-inbox switch clears anchors: new-session replies do not thread onto old-session messages', async () => {
  const { server, state, port } = await startMockTelegram()
  const { server: dash, port: dashPort } = await startMockDashboard()
  const home = makeHome()
  const now = Math.floor(Date.now() / 1000)
  // FRESH anchor from the current session (would legitimately thread pre-switch).
  writeMessageMap(home, {
    _userMessageAnchors: [
      { inboxCountAtSend: 0, telegramMessageId: 9999, at: Date.now() },
    ],
  })
  setTeamInbox(home, 'session-1', ['s1-reply'])
  setDashMtime(home, 'session-1', now)
  const proc = spawnWatcher(home, port, dashPort, { TG_INBOX_SWITCH_HYSTERESIS_MS: '1000' })
  try {
    assert.ok(await waitFor(() => sentCount(home) === 1), 's1 reply delivered')
    // Escape the 5s edit-coalesce window so the post-switch reply is a real sendMessage
    // (an edit would bypass the threading path under test).
    await sleep(5200)
    // Orchestrator restarts under a new session team, decisively newer.
    setTeamInbox(home, 'session-2', ['s2-reply'])
    setDashMtime(home, 'session-2', now + 600)
    assert.ok(await waitFor(() => state.sent.some(b => (b.text || '').includes('s2-reply'))), 's2 reply delivered after switch')
    const s2 = state.sent.find(b => (b.text || '').includes('s2-reply'))
    assert.notEqual(s2.reply_to_message_id, 9999,
      'must NOT thread a new-session reply onto the old session\'s anchor')
  } finally { await stop(proc); dash.close(); server.close() }
})

test('fresh inbound message: reply IS threaded to it and carries allow_sending_without_reply', async () => {
  const { server, state, port } = await startMockTelegram()
  const { server: dash, state: dashState, port: dashPort } = await startMockDashboard()
  const home = makeHome()
  setTeamInbox(home, 'session-1', [])
  // Jeff sends a message via Telegram (message_id 555).
  state.updates.push({
    update_id: 1,
    message: { message_id: 555, chat: { id: 12345 }, text: 'hello from jeff' },
  })
  const proc = spawnWatcher(home, port, dashPort)
  try {
    assert.ok(await waitFor(() => dashState.relayed.length >= 1), 'inbound relayed to dashboard')
    // Orchestrator replies via the dashboard-user inbox.
    appendTeamInbox(home, 'session-1', 'answer for jeff')
    assert.ok(await waitFor(() => state.sent.some(b => (b.text || '').includes('answer for jeff'))), 'reply delivered')
    const msg = state.sent.find(b => (b.text || '').includes('answer for jeff'))
    assert.equal(msg.reply_to_message_id, 555, 'threads onto the fresh user message')
    assert.equal(msg.allow_sending_without_reply, true,
      'threaded sends must set allow_sending_without_reply so a bad target cannot block delivery')
  } finally { await stop(proc); dash.close(); server.close() }
})

// Rapid-fire regression (observed live 2026-07-03 21:50–21:53): user sent two messages
// before any reply ("Test message 3:47pm" id=10821, then "Are you getting my messages?"
// id=10822 — anchors share one inboxCountAtSend). BOTH replies threaded to 10821; 10822
// never got a threaded answer. Successive replies must ADVANCE across the group's
// anchors in arrival order (consuming each), not pile onto the first forever.
test('rapid-fire messages: successive replies advance across anchors in order', async () => {
  const { server, state, port } = await startMockTelegram()
  const { server: dash, port: dashPort } = await startMockDashboard()
  const home = makeHome()
  writeMessageMap(home, {
    _userMessageAnchors: [
      { inboxCountAtSend: 0, telegramMessageId: 111, at: Date.now() },
      { inboxCountAtSend: 0, telegramMessageId: 222, at: Date.now() },
    ],
  })
  setTeamInbox(home, 'session-1', ['first answer'])
  const proc = spawnWatcher(home, port, dashPort)
  try {
    assert.ok(await waitFor(() => state.sent.some(b => (b.text || '').includes('first answer'))), 'first reply delivered')
    const r1 = state.sent.find(b => (b.text || '').includes('first answer'))
    assert.equal(r1.reply_to_message_id, 111, 'first reply threads to the FIRST rapid-fire message')
    // Escape the 5s edit-coalesce window so the second reply is a real sendMessage.
    await sleep(5200)
    appendTeamInbox(home, 'session-1', 'second answer')
    assert.ok(await waitFor(() => state.sent.some(b => (b.text || '').includes('second answer'))), 'second reply delivered')
    const r2 = state.sent.find(b => (b.text || '').includes('second answer'))
    assert.equal(r2.reply_to_message_id, 222, 'second reply advances to the SECOND message, not the first again')
    // A third reply after the group is exhausted stays on the LAST message (progress updates).
    await sleep(5200)
    appendTeamInbox(home, 'session-1', 'third update')
    assert.ok(await waitFor(() => state.sent.some(b => (b.text || '').includes('third update'))), 'third reply delivered')
    const r3 = state.sent.find(b => (b.text || '').includes('third update'))
    assert.equal(r3.reply_to_message_id, 222, 'exhausted group keeps threading to the most recent message')
  } finally { await stop(proc); dash.close(); server.close() }
})
