// Integration tests: a watcher restart/handoff must NEVER silently drop a
// dashboard-user -> Telegram outbound message (the 2026-05-27 follow-up requirement).
//
// Runs the REAL telegram-watcher.mjs as a subprocess against a mock Telegram HTTP
// server (TELEGRAM_API_BASE override) with an isolated SUPERBOT2_HOME. Verifies:
//   1. happy path relays + advances the persisted counter per delivered message;
//   2. a send FAILURE does NOT advance the counter (so it retries — no drop), then
//      recovers and delivers when the API comes back;
//   3. SIGTERM with a pending message flushes it before exit (graceful restart),
//      even with the periodic poll disabled.
// Run: node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WATCHER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'telegram-watcher.mjs')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Mock Telegram Bot API server. `state.failSend` toggles sendMessage failures.
function startMockTelegram() {
  const state = { sent: [], edited: [], failSend: false }
  // All text that reached Telegram, whether via a new message or an edit-coalesce.
  state.deliveredText = () => [...state.sent, ...state.edited].join('\n')
  const server = createServer((req, res) => {
    const method = req.url.split('/').pop()
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const reply = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
      if (method === 'getMe') return reply({ ok: true, result: { username: 'mockbot', first_name: 'Mock' } })
      if (method === 'getUpdates') return reply({ ok: true, result: [] }) // never any inbound
      if (method === 'setMyCommands') return reply({ ok: true, result: true })
      if (method === 'sendChatAction') return reply({ ok: true, result: true })
      if (method === 'editMessageText') {
        let parsed = {}
        try { parsed = JSON.parse(body) } catch {}
        state.edited.push(parsed.text || '')
        return reply({ ok: true, result: { message_id: parsed.message_id, text: parsed.text } })
      }
      if (method === 'sendMessage') {
        if (state.failSend) return reply({ ok: false, description: 'simulated failure' })
        let parsed = {}
        try { parsed = JSON.parse(body) } catch {}
        state.sent.push(parsed.text || '')
        return reply({ ok: true, result: { message_id: state.sent.length, text: parsed.text } })
      }
      return reply({ ok: true, result: {} })
    })
  })
  return new Promise(r => server.listen(0, () => r({ server, state, port: server.address().port })))
}

function makeHome(replies) {
  const home = mkdtempSync(join(tmpdir(), 'tg-nodrop-'))
  mkdirSync(join(home, '.claude', 'teams', 'superbot2', 'inboxes'), { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    telegram: { enabled: true, botToken: 'test', chatId: '12345' },
  }))
  setInbox(home, replies)
  // Skip the getUpdates bootstrap's "skip old updates" so startup is fast/deterministic.
  writeFileSync(join(home, 'telegram-last-update-id.txt'), '0')
  return home
}
function inboxPath(home) { return join(home, '.claude', 'teams', 'superbot2', 'inboxes', 'dashboard-user.json') }
function setInbox(home, replies) {
  writeFileSync(inboxPath(home), JSON.stringify(replies.map(t => ({ from: 'team-lead', text: t }))))
}
function appendInbox(home, text) {
  const a = JSON.parse(readFileSync(inboxPath(home), 'utf8'))
  a.push({ from: 'team-lead', text })
  writeFileSync(inboxPath(home), JSON.stringify(a))
}
function sentCount(home) {
  const f = join(home, 'telegram-last-sent-idx.txt')
  return existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0
}

function spawnWatcher(home, port, extraEnv = {}) {
  return spawn('node', [WATCHER], {
    env: {
      ...process.env,
      SUPERBOT2_HOME: home,
      TELEGRAM_API_BASE: `http://127.0.0.1:${port}/bot`,
      TG_REPLY_POLL_INTERVAL: '500',
      ...extraEnv,
    },
    stdio: 'ignore',
  })
}
async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) { if (await fn()) return true; await sleep(150) }
  return false
}
async function stop(proc) {
  if (!proc || proc.killed) return
  proc.kill('SIGKILL')
  await new Promise(r => proc.on('exit', r))
}

test('happy path: relays pending replies and advances persisted counter', async () => {
  const { server, state, port } = await startMockTelegram()
  const home = makeHome(['hello one', 'hello two'])
  const proc = spawnWatcher(home, port)
  try {
    // Both replies must be delivered (possibly the 2nd via edit-coalescing within 5s)
    // and the counter must advance to 2.
    const ok = await waitFor(() => sentCount(home) === 2)
    assert.ok(ok, `counter should reach 2, was ${sentCount(home)}`)
    const delivered = state.deliveredText()
    assert.ok(delivered.includes('hello one'), 'first reply delivered')
    assert.ok(delivered.includes('hello two'), 'second reply delivered')
    assert.ok(state.sent.length >= 1, 'at least one real send occurred')
  } finally { await stop(proc); server.close() }
})

test('no-drop: a send failure does NOT advance the counter, then recovers', async () => {
  const { server, state, port } = await startMockTelegram()
  state.failSend = true
  const home = makeHome(['must not be dropped'])
  const proc = spawnWatcher(home, port)
  try {
    // Give it time to attempt (and fail, with retries) several cycles.
    await sleep(3000)
    assert.equal(sentCount(home), 0, 'counter must stay 0 while delivery fails (no silent drop)')
    assert.equal(state.sent.length, 0, 'no successful send recorded yet')
    // Recover the API — the message must now be delivered without being skipped.
    state.failSend = false
    assert.ok(await waitFor(() => state.sent.length === 1), 'message should deliver after recovery')
    assert.equal(state.sent[0], 'must not be dropped')
    assert.ok(await waitFor(() => sentCount(home) === 1), 'counter advances only after real delivery')
  } finally { await stop(proc); server.close() }
})

test('graceful shutdown flushes a pending message before exit', async () => {
  const { server, state, port } = await startMockTelegram()
  const home = makeHome([])
  // Disable the periodic poll so ONLY the shutdown flush can deliver the message.
  const proc = spawnWatcher(home, port, { TG_REPLY_POLL_INTERVAL: '600000' })
  try {
    // Wait for startup (getMe handshake) to complete.
    await sleep(1500)
    appendInbox(home, 'pending during shutdown')
    assert.equal(state.sent.length, 0, 'periodic poll disabled — nothing sent yet')
    proc.kill('SIGTERM') // triggers graceful flush
    const flushed = await waitFor(() => state.sent.length === 1, 10000)
    assert.ok(flushed, 'pending message must be flushed to Telegram on graceful shutdown')
    assert.equal(state.sent[0], 'pending during shutdown')
  } finally { await stop(proc); server.close() }
})
