// Reproduces + guards the inbound HTTP 500 outage (2026-06-25 14:29:37).
//
// POST /api/messages resolves the ACTIVE orchestrator team and writes the inbound user
// message to that team's inboxes/team-lead.json. During an orchestrator restart the active
// team can momentarily have a config.json but no inboxes/ directory yet (the harness creates
// the team dir + config before the inbox files exist), so writeFile threw ENOENT -> 500 and
// the user's message was silently dropped. The fix mkdir -p's the inbox dir before writing.
//
// This boots the real dashboard server against a temp SUPERBOT2_HOME with exactly that
// "config but no inbox dir" state and asserts the POST returns 200 and the message lands.
//
// Run: node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const SERVER = join(import.meta.dirname, '..', 'dashboard', 'server.js')

function waitForServer(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  return (async () => {
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/messages`)
        if (r.ok || r.status === 200) return true
      } catch {
        // not up yet
      }
      await new Promise((res) => setTimeout(res, 150))
    }
    throw new Error('server did not start in time')
  })()
}

test('POST /api/messages returns 200 and writes inbound even when the active team inbox dir does not exist yet', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sb-inbound-'))
  // Active session team with a config.json but NO inboxes/ directory — the restart-window
  // state that produced the 500.
  const teamDir = join(home, '.claude', 'teams', 'session-restartwin')
  mkdirSync(teamDir, { recursive: true })
  writeFileSync(
    join(teamDir, 'config.json'),
    JSON.stringify({ name: 'session-restartwin', members: [{ name: 'team-lead' }] })
  )
  assert.ok(!existsSync(join(teamDir, 'inboxes')), 'precondition: inboxes dir is absent')

  const port = 39000 + Math.floor(Math.random() * 2000)
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      SUPERBOT2_HOME: home,
      SUPERBOT2_NAME: 'superbot2', // legacy default -> auto-detect runs
      SUPERBOT2_API_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))

  try {
    await waitForServer(port)

    const res = await fetch(`http://127.0.0.1:${port}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'restart-window inbound message' }),
    })
    assert.equal(res.status, 200, `expected 200, got ${res.status} (stderr: ${stderr.slice(0, 400)})`)
    const body = await res.json()
    assert.equal(body.ok, true)

    // Message must have landed in the active team's team-lead.json (dir auto-created).
    const inboxPath = join(teamDir, 'inboxes', 'team-lead.json')
    assert.ok(existsSync(inboxPath), 'inbox file created by mkdir -p + write')
    const inbox = JSON.parse(readFileSync(inboxPath, 'utf-8'))
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].from, 'dashboard-user')
    assert.equal(inbox[0].text, 'restart-window inbound message')
  } finally {
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
})
