// Integration tests for ACTIVE TEAM INBOX resolution (root-caused 2026-06-17).
//
// The orchestrator no longer registers as team 'superbot2' — each session gets a
// session-based team name (e.g. 'session-475577c1'), so its dashboard-user.json lives
// under teams/<session>/inboxes/ which changes across restarts. The watcher must
// auto-detect the most-recently-modified real dashboard-user.json instead of a fixed
// team name, re-resolve every poll cycle, and not double-send when the active inbox
// switches mid-run.
//
// Runs the REAL telegram-watcher.mjs against a mock Telegram HTTP server with an
// isolated SUPERBOT2_HOME. Run: node --test test/
//
// Mirrors test/telegram-watcher-nodrop.test.mjs (same mock + spawn harness).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WATCHER = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'telegram-watcher.mjs')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function startMockTelegram() {
  const state = { sent: [], edited: [] }
  state.deliveredText = () => [...state.sent, ...state.edited].join('\n')
  const server = createServer((req, res) => {
    const method = req.url.split('/').pop()
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const reply = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
      if (method === 'getMe') return reply({ ok: true, result: { username: 'mockbot', first_name: 'Mock' } })
      if (method === 'getUpdates') return reply({ ok: true, result: [] })
      if (method === 'setMyCommands') return reply({ ok: true, result: true })
      if (method === 'sendChatAction') return reply({ ok: true, result: true })
      if (method === 'editMessageText') {
        let parsed = {}; try { parsed = JSON.parse(body) } catch {}
        state.edited.push(parsed.text || '')
        return reply({ ok: true, result: { message_id: parsed.message_id, text: parsed.text } })
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

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'tg-inbox-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    telegram: { enabled: true, botToken: 'test', chatId: '12345' },
  }))
  writeFileSync(join(home, 'telegram-last-update-id.txt'), '0')
  return home
}

function teamInboxDir(home, team) {
  return join(home, '.claude', 'teams', team, 'inboxes')
}
function ensureTeam(home, team) {
  const dir = teamInboxDir(home, team)
  mkdirSync(dir, { recursive: true })
  return dir
}
// Write a team's dashboard-user.json (and bump its mtime by writing). Optionally also
// touch team-lead.json so the team looks "active".
function setTeamInbox(home, team, replies, { touchLead = true } = {}) {
  ensureTeam(home, team)
  writeFileSync(
    join(teamInboxDir(home, team), 'dashboard-user.json'),
    JSON.stringify(replies.map(t => ({ from: 'team-lead', text: t }))),
  )
  if (touchLead) {
    writeFileSync(join(teamInboxDir(home, team), 'team-lead.json'), '[]')
  }
}
function appendTeamInbox(home, team, text) {
  const f = join(teamInboxDir(home, team), 'dashboard-user.json')
  const a = JSON.parse(readFileSync(f, 'utf8'))
  a.push({ from: 'team-lead', text })
  writeFileSync(f, JSON.stringify(a))
}
function sentCount(home) {
  const f = join(home, 'telegram-last-sent-idx.txt')
  return existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0
}
// Set an explicit mtime (epoch seconds) on a team's dashboard-user.json — lets us drive
// the switch-hysteresis logic deterministically without relying on wall-clock writes.
function setDashMtime(home, team, epochSec) {
  const f = join(teamInboxDir(home, team), 'dashboard-user.json')
  utimesSync(f, epochSec, epochSec)
}
function touchLead(home, team, epochSec) {
  const f = join(teamInboxDir(home, team), 'team-lead.json')
  if (!existsSync(f)) writeFileSync(f, '[]')
  if (epochSec != null) utimesSync(f, epochSec, epochSec)
}

function spawnWatcher(home, port, extraEnv = {}) {
  return spawn('node', [WATCHER], {
    env: {
      ...process.env,
      SUPERBOT2_HOME: home,
      TELEGRAM_API_BASE: `http://127.0.0.1:${port}/bot`,
      TG_REPLY_POLL_INTERVAL: '400',
      // IMPORTANT: do NOT inherit a real SUPERBOT2_NAME — we test auto-detection.
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

test('auto-detects a session-named team inbox (not hardcoded superbot2)', async () => {
  const { server, state, port } = await startMockTelegram()
  const home = makeHome()
  // A stale legacy team with OLD content, and the live session team with newer content.
  setTeamInbox(home, 'superbot2', ['STALE legacy reply'])
  await sleep(20)
  setTeamInbox(home, 'session-abc123', ['live session reply'])
  const proc = spawnWatcher(home, port)
  try {
    assert.ok(await waitFor(() => state.sent.length >= 1), 'a reply should be delivered')
    const delivered = state.deliveredText()
    assert.ok(delivered.includes('live session reply'), 'forwarded the live session inbox')
    assert.ok(!delivered.includes('STALE legacy reply'), 'did NOT forward the stale legacy inbox')
  } finally { await stop(proc); server.close() }
})

test('a band-aid SYMLINK at superbot2 is ignored (resolver rejects symlinks)', async () => {
  const { server, state, port } = await startMockTelegram()
  const home = makeHome()
  // Live session inbox.
  setTeamInbox(home, 'session-xyz', ['real reply via session'])
  // Legacy team dir whose dashboard-user.json is a symlink to the session inbox
  // (this is exactly the band-aid). Make the symlink the NEWEST-touched path.
  ensureTeam(home, 'superbot2')
  await sleep(20)
  symlinkSync(
    join('..', '..', 'session-xyz', 'inboxes', 'dashboard-user.json'),
    join(teamInboxDir(home, 'superbot2'), 'dashboard-user.json'),
  )
  const proc = spawnWatcher(home, port)
  try {
    assert.ok(await waitFor(() => state.sent.length >= 1), 'a reply should be delivered')
    // Must deliver exactly once even though two paths (real + symlink) point at the same
    // content — the symlink is rejected, so only the real session inbox is read.
    assert.ok(await waitFor(() => sentCount(home) === 1), `counter should be 1, was ${sentCount(home)}`)
    await sleep(800) // a couple more poll cycles
    assert.equal(state.sent.length, 1, 'no double-send from the symlink path')
  } finally { await stop(proc); server.close() }
})

test('mid-run session switch: forwards the new inbox once, no double-send', async () => {
  const { server, state, port } = await startMockTelegram()
  const home = makeHome()
  const now = Math.floor(Date.now() / 1000)
  // Start on session-1 with two replies; let them deliver.
  setTeamInbox(home, 'session-1', ['s1-a', 's1-b'])
  setDashMtime(home, 'session-1', now)
  // Short hysteresis — this test exercises the switch mechanic, not hysteresis itself.
  const proc = spawnWatcher(home, port, { TG_INBOX_SWITCH_HYSTERESIS_MS: '1000' })
  try {
    assert.ok(await waitFor(() => sentCount(home) === 2), `counter should reach 2, was ${sentCount(home)}`)
    const afterFirst = state.sent.length + state.edited.length
    assert.ok(state.deliveredText().includes('s1-a') && state.deliveredText().includes('s1-b'))

    // Orchestrator "restarts" under a new session team with a FRESH inbox that is
    // DECISIVELY newer than session-1's live mtime (the old session has gone quiet).
    await sleep(30)
    setTeamInbox(home, 'session-2', ['s2-a'])
    setDashMtime(home, 'session-2', now + 600)

    // The new inbox's content is forwarded exactly once after the switch.
    assert.ok(await waitFor(() => state.deliveredText().includes('s2-a')), 's2-a forwarded after switch')
    assert.ok(await waitFor(() => sentCount(home) === 1), `counter resets+advances to 1, was ${sentCount(home)}`)

    // Settle several cycles; s2-a must not be re-sent, and old s1 replies must NOT reappear.
    await sleep(1200)
    const s2count = state.deliveredText().split('s2-a').length - 1
    assert.equal(s2count, 1, 's2-a delivered exactly once (no double-send on switch)')
  } finally { await stop(proc); server.close() }
})

test('oscillation guard: a near-tie / leadMtime touch does NOT flip+re-blast', async () => {
  const { server, state, port } = await startMockTelegram()
  const home = makeHome()
  const now = Math.floor(Date.now() / 1000)
  // Team A is the active inbox (newest dash mtime); team B exists but is older.
  setTeamInbox(home, 'session-A', ['A-reply'])
  setTeamInbox(home, 'session-B', ['B-reply'])
  setDashMtime(home, 'session-A', now)        // A newest -> watcher locks onto A
  setDashMtime(home, 'session-B', now - 100)  // B clearly older
  // Big hysteresis so only a DECISIVE change can flip the active inbox.
  const proc = spawnWatcher(home, port, { TG_INBOX_SWITCH_HYSTERESIS_MS: '60000' })
  try {
    // A's reply is forwarded; B's must NOT be.
    assert.ok(await waitFor(() => state.deliveredText().includes('A-reply')), 'A-reply forwarded')
    assert.ok(await waitFor(() => sentCount(home) === 1), `counter=1, was ${sentCount(home)}`)

    // 1) An inbound relay merely TOUCHES team-lead.json of BOTH teams (newer than dash) —
    //    must NOT change which inbox we forward from (leadMtime is not a selection signal).
    touchLead(home, 'session-B', now + 5000)
    touchLead(home, 'session-A', now + 5000)
    // 2) B's dashboard-user.json becomes only SLIGHTLY newer than A — within hysteresis.
    setDashMtime(home, 'session-B', now + 1)
    setDashMtime(home, 'session-A', now)

    // Give several poll cycles. The watcher must HOLD on A — no flip, no re-blast.
    await sleep(1600)
    assert.ok(!state.deliveredText().includes('B-reply'), 'must NOT have switched to B (no re-blast)')
    const aCount = state.deliveredText().split('A-reply').length - 1
    assert.equal(aCount, 1, 'A-reply delivered exactly once (no oscillation re-blast)')
    assert.equal(sentCount(home), 1, 'counter unchanged — no spurious switch/reset')
  } finally { await stop(proc); server.close() }
})

test('decisive newer inbox DOES switch (hysteresis cleared) and forwards once', async () => {
  const { server, state, port } = await startMockTelegram()
  const home = makeHome()
  const now = Math.floor(Date.now() / 1000)
  setTeamInbox(home, 'session-old', ['old-reply'])
  setDashMtime(home, 'session-old', now - 10)
  // Short hysteresis so the test is fast; a decisively-newer inbox must win.
  const proc = spawnWatcher(home, port, { TG_INBOX_SWITCH_HYSTERESIS_MS: '1000' })
  try {
    assert.ok(await waitFor(() => sentCount(home) === 1), 'old-reply forwarded first')
    // A brand-new session inbox appears, decisively newer than current's live mtime.
    setTeamInbox(home, 'session-new', ['new-reply'])
    setDashMtime(home, 'session-new', now + 600) // far beyond the 1s hysteresis margin
    assert.ok(await waitFor(() => state.deliveredText().includes('new-reply')), 'switched to new inbox')
    assert.ok(await waitFor(() => sentCount(home) === 1), 'counter reset+advanced to 1 on switch')
    await sleep(1000)
    const newCount = state.deliveredText().split('new-reply').length - 1
    assert.equal(newCount, 1, 'new-reply delivered exactly once after switch')
  } finally { await stop(proc); server.close() }
})

test('SUPERBOT2_NAME override pins a fixed team even if another is newer', async () => {
  const { server, state, port } = await startMockTelegram()
  const home = makeHome()
  setTeamInbox(home, 'superbot2', ['pinned reply'])
  await sleep(20)
  setTeamInbox(home, 'session-newer', ['newer session reply'])
  // Force the legacy team via the env override.
  const proc = spawnWatcher(home, port, { SUPERBOT2_NAME: 'superbot2' })
  try {
    assert.ok(await waitFor(() => state.sent.length >= 1), 'a reply should be delivered')
    const delivered = state.deliveredText()
    assert.ok(delivered.includes('pinned reply'), 'forwarded the pinned (override) team inbox')
    assert.ok(!delivered.includes('newer session reply'), 'ignored the newer team because override is set')
  } finally { await stop(proc); server.close() }
})
