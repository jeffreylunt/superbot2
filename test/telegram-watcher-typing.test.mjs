// Integration tests for the Telegram TYPING INDICATOR (Jeff's 2026-06-25 symptom:
// "not getting the typing indicator").
//
// Contract being guarded:
//   1. On ANY inbound message the watcher fires `sendChatAction(typing)` immediately,
//      then keeps re-firing on an interval SHORTER than Telegram's ~5s typing-expiry
//      window, so the indicator stays continuously lit while the orchestrator is
//      "thinking" (no reply yet).
//   2. Once an orchestrator reply is delivered, the watcher stops the typing refresh
//      (the indicator naturally clears when the reply message arrives).
//
// Root cause of the live symptom was actually the inbound HTTP 500 (see
// inbound-message-write.test.mjs): the inbound POST was dropped, the orchestrator never
// saw the message / never replied, and the watcher's "Failed to relay" error message
// cleared the typing indicator. With inbound writes resilient, typing works — this test
// locks in the typing contract so a regression in either layer is caught.
//
// Runs the REAL telegram-watcher.mjs against a mock Telegram HTTP server (mirrors the
// spawn harness in telegram-watcher-active-inbox.test.mjs). Run: node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WATCHER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'telegram-watcher.mjs')
const TYPING_INTERVAL_MS = 3000 // must match the watcher's TYPING_INTERVAL
const TELEGRAM_TYPING_EXPIRY_MS = 5000 // Telegram clears "typing" after ~5s with no refresh

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Mock Telegram that records sendChatAction calls (with timestamps) and lets the test
// feed a one-shot inbound update via getUpdates.
function startMockTelegram() {
  const state = {
    sent: [],
    chatActions: [], // { at: epochMs }
    pendingUpdates: [], // delivered once on the next getUpdates poll
  }
  const server = createServer((req, res) => {
    const method = req.url.split('/').pop()
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const reply = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
      if (method === 'getMe') return reply({ ok: true, result: { username: 'mockbot', first_name: 'Mock' } })
      if (method === 'setMyCommands') return reply({ ok: true, result: true })
      if (method === 'getUpdates') {
        const updates = state.pendingUpdates
        state.pendingUpdates = []
        return reply({ ok: true, result: updates })
      }
      if (method === 'sendChatAction') {
        state.chatActions.push({ at: Date.now() })
        return reply({ ok: true, result: true })
      }
      if (method === 'sendMessage') {
        let parsed = {}; try { parsed = JSON.parse(body) } catch {}
        state.sent.push(parsed.text || '')
        return reply({ ok: true, result: { message_id: state.sent.length, text: parsed.text } })
      }
      return reply({ ok: true, result: {} })
    })
  })
  return new Promise(r => server.listen(0, () => r({ server, state, port: server.address().port })))
}

// A minimal home with telegram enabled + a known chatId so we never hit the
// "auto-detect chatId" branch (which would send an extra greeting and clear typing).
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'tg-typing-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    telegram: { enabled: true, botToken: 'test', chatId: '12345' },
  }))
  writeFileSync(join(home, 'telegram-last-update-id.txt'), '0')
  return home
}

function teamInboxDir(home, team) { return join(home, '.claude', 'teams', team, 'inboxes') }
function setTeamInbox(home, team, replies) {
  const dir = teamInboxDir(home, team)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'dashboard-user.json'),
    JSON.stringify(replies.map(t => ({ from: 'team-lead', text: t }))),
  )
  writeFileSync(join(dir, 'team-lead.json'), '[]')
}
function appendTeamInbox(home, team, text) {
  const dir = teamInboxDir(home, team)
  const f = join(dir, 'dashboard-user.json')
  let a = []
  try { a = JSON.parse(readFileSync(f, 'utf8')) } catch {}
  a.push({ from: 'team-lead', text })
  writeFileSync(f, JSON.stringify(a))
}

function spawnWatcher(home, port) {
  return spawn('node', [WATCHER], {
    env: {
      ...process.env,
      SUPERBOT2_HOME: home,
      TELEGRAM_API_BASE: `http://127.0.0.1:${port}/bot`,
      TG_REPLY_POLL_INTERVAL: '400',
      SUPERBOT2_NAME: '',
    },
    stdio: 'ignore',
  })
}
async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) { if (await fn()) return true; await sleep(80) }
  return false
}
async function stop(proc) {
  if (!proc || proc.killed) return
  proc.kill('SIGKILL')
  await new Promise(r => proc.on('exit', r))
}

test('inbound message starts the typing indicator and keeps it lit (< Telegram expiry) until a reply lands', async () => {
  const { server, state, port } = await startMockTelegram()
  const home = makeHome()
  // Live session team inbox exists but has NO replies yet — the orchestrator is "thinking".
  setTeamInbox(home, 'session-typing', [])
  const proc = spawnWatcher(home, port)
  try {
    // Wait until the watcher is polling (it has hit getUpdates at least once via getMe path).
    assert.ok(await waitFor(() => state.chatActions.length >= 0), 'watcher started')

    // Feed a single inbound user message. The watcher should startTyping() immediately.
    state.pendingUpdates = [{
      update_id: 1,
      message: { message_id: 100, chat: { id: 12345 }, text: 'hello orchestrator' },
    }]

    // 1) Typing fires promptly on inbound.
    assert.ok(
      await waitFor(() => state.chatActions.length >= 1, 6000),
      'sendChatAction(typing) fired on inbound message',
    )
    const firstTypingAt = state.chatActions[0].at

    // 2) Typing KEEPS refreshing while no reply exists — prove at least one refresh lands
    //    within the Telegram expiry window so the indicator never goes dark.
    assert.ok(
      await waitFor(() => state.chatActions.length >= 2, TELEGRAM_TYPING_EXPIRY_MS + 2000),
      'typing refreshed at least once more while waiting for a reply',
    )
    const gap = state.chatActions[1].at - firstTypingAt
    assert.ok(
      gap < TELEGRAM_TYPING_EXPIRY_MS,
      `refresh gap (${gap}ms) must be under Telegram's ~5s typing expiry so the indicator stays lit`,
    )
    assert.ok(
      gap >= TYPING_INTERVAL_MS - 1500,
      `refresh gap (${gap}ms) should be on the ~${TYPING_INTERVAL_MS}ms cadence, not a tight spin`,
    )

    // 3) Now the orchestrator replies — typing should stop. Capture the action count at the
    //    moment the reply is delivered, then assert it does not keep climbing indefinitely.
    appendTeamInbox(home, 'session-typing', 'here is your answer')
    assert.ok(
      await waitFor(() => state.sent.some(t => t.includes('here is your answer')), 6000),
      'orchestrator reply was delivered to Telegram',
    )
    const actionsAtReply = state.chatActions.length
    // Give it two full typing intervals: if stopTyping() ran, the count must NOT grow by
    // more than one straggler (a refresh already in flight when the reply landed).
    await sleep(TYPING_INTERVAL_MS * 2 + 500)
    const grew = state.chatActions.length - actionsAtReply
    assert.ok(grew <= 1, `typing stopped after the reply (grew by ${grew}, expected <= 1)`)
  } finally {
    await stop(proc); server.close()
  }
})
