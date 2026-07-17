// Integration tests for the end-to-end CANARY (added 2026-07-17 after two weeks of
// incidents that were each discovered only when Jeff messaged and got silence).
//
// The canary injects a synthetic message through the same inbound path as a real
// Telegram message (dashboard POST → team inbox → orchestrator → SendMessage reply)
// and expects a '[canary-ack <nonce>]' reply, which the watcher SWALLOWS. No ack in
// time ⇒ one direct Telegram alert to Jeff, latched until recovery.
//
// Runs the REAL telegram-watcher.mjs against a mock Telegram + mock dashboard with an
// isolated SUPERBOT2_HOME (same harness as telegram-watcher-nodrop.test.mjs), with the
// canary timers compressed to test speed.

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

function startMockTelegram() {
  const state = { sent: [] }
  const server = createServer((req, res) => {
    const method = req.url.split('/').pop()
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const reply = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
      if (method === 'getMe') return reply({ ok: true, result: { username: 'mockbot', first_name: 'Mock' } })
      if (method === 'getUpdates') return reply({ ok: true, result: [] })
      if (method === 'sendMessage') {
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

// Mock dashboard: records canary injections on POST /api/messages.
function startMockDashboard() {
  const state = { injected: [] }
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      if (req.url === '/api/messages' && req.method === 'POST') {
        try { state.injected.push(JSON.parse(body).text || '') } catch { state.injected.push('') }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  return new Promise(r => server.listen(0, () => r({ server, state, port: server.address().port })))
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'tg-canary-'))
  mkdirSync(join(home, '.claude', 'teams', 'superbot2', 'inboxes'), { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    telegram: { enabled: true, botToken: 'test', chatId: '12345' },
  }))
  writeFileSync(join(home, '.claude', 'teams', 'superbot2', 'inboxes', 'dashboard-user.json'), '[]')
  writeFileSync(join(home, '.claude', 'teams', 'superbot2', 'inboxes', 'team-lead.json'), '[]')
  writeFileSync(join(home, 'telegram-last-update-id.txt'), '0')
  return home
}
function writeAck(home, nonce) {
  const f = join(home, '.claude', 'teams', 'superbot2', 'inboxes', 'dashboard-user.json')
  const a = JSON.parse(readFileSync(f, 'utf8'))
  a.push({ from: 'team-lead', text: `[canary-ack ${nonce}]` })
  writeFileSync(f, JSON.stringify(a))
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
      TG_REPLY_POLL_INTERVAL: '300',
      // Compressed canary clock: first canary ~0.5s after boot, ticks every 300ms,
      // times out after 2s, next interval after 2s.
      TG_CANARY_INITIAL_DELAY_MS: '500',
      TG_CANARY_TICK_MS: '300',
      TG_CANARY_TIMEOUT_MS: '2000',
      TG_CANARY_INTERVAL_MS: '2000',
      SUPERBOT2_NAME: '',
      ...extraEnv,
    },
    stdio: 'ignore',
  })
}
async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) { if (await fn()) return true; await sleep(100) }
  return false
}
async function stop(proc) {
  if (!proc || proc.killed) return
  proc.kill('SIGKILL')
  await new Promise(r => proc.on('exit', r))
}

test('canary round-trip: injected via dashboard, ack swallowed, no Telegram traffic to Jeff', async () => {
  const { server: tg, state: tgState, port: tgPort } = await startMockTelegram()
  const { server: dash, state: dashState, port: dashPort } = await startMockDashboard()
  const home = makeHome()
  const proc = spawnWatcher(home, tgPort, dashPort)
  try {
    // Canary injected through the dashboard (same leg as a real Telegram relay).
    assert.ok(await waitFor(() => dashState.injected.some(t => t.startsWith('[canary '))), 'canary was injected')
    const nonce = dashState.injected.find(t => t.startsWith('[canary ')).match(/^\[canary ([a-z0-9]+)\]/)[1]
    // Orchestrator "replies" with the ack.
    writeAck(home, nonce)
    // The ack is consumed (counter advances) but NEVER forwarded to Jeff's Telegram.
    assert.ok(await waitFor(() => sentCount(home) >= 1), 'ack consumed (counter advanced)')
    await sleep(500)
    assert.ok(!tgState.sent.some(t => (t || '').includes('canary')), 'no canary traffic reached Telegram')
  } finally { await stop(proc); dash.close(); tg.close() }
})

test('canary timeout: one failure alert to Jeff, then a recovery note on the next ack', async () => {
  const { server: tg, state: tgState, port: tgPort } = await startMockTelegram()
  const { server: dash, state: dashState, port: dashPort } = await startMockDashboard()
  const home = makeHome()
  const proc = spawnWatcher(home, tgPort, dashPort)
  try {
    assert.ok(await waitFor(() => dashState.injected.length >= 1), 'first canary injected')
    // No ack ⇒ after the (compressed) timeout, exactly one alert reaches Jeff.
    assert.ok(await waitFor(() => tgState.sent.some(t => t.includes('end-to-end check failed'))), 'failure alert sent')
    await sleep(2500) // several more ticks + a second canary cycle
    const alerts = tgState.sent.filter(t => t.includes('end-to-end check failed'))
    assert.equal(alerts.length, 1, `alert must be latched (got ${alerts.length})`)
    // A later canary gets acked ⇒ single recovery note.
    assert.ok(await waitFor(() => dashState.injected.length >= 2), 'canary retried after failure')
    const lastNonce = dashState.injected.filter(t => t.startsWith('[canary ')).pop().match(/^\[canary ([a-z0-9]+)\]/)[1]
    writeAck(home, lastNonce)
    assert.ok(await waitFor(() => tgState.sent.some(t => t.includes('recovered'))), 'recovery note sent')
  } finally { await stop(proc); dash.close(); tg.close() }
})
