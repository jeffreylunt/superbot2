// Tests for dashboard/inbox-migration.mjs — stranded-inbox migration on session rotation.
// Uses real tmp-dir team fixtures (no mocks of fs): the module's job IS the fs layout.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateStrandedInboxes, isControlMessage, messageId } from '../dashboard/inbox-migration.mjs'

const NOW = Date.parse('2026-07-04T06:00:00.000Z')
const HOUR = 3600 * 1000

let root
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'inbox-migration-'))
})
test.afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function makeTeam(name, { config = true, configAgeMs = 0, leadInbox = null, otherInboxes = {} } = {}) {
  const teamDir = join(root, name)
  const inboxesDir = join(teamDir, 'inboxes')
  await mkdir(inboxesDir, { recursive: true })
  if (config) {
    const cfgPath = join(teamDir, 'config.json')
    await writeFile(cfgPath, JSON.stringify({ name }))
    await setAge(cfgPath, configAgeMs)
  }
  if (leadInbox !== null) {
    await writeFile(join(inboxesDir, 'team-lead.json'), JSON.stringify(leadInbox))
  }
  for (const [file, { entries = [], ageMs = 0 }] of Object.entries(otherInboxes)) {
    const p = join(inboxesDir, file)
    await writeFile(p, JSON.stringify(entries))
    await setAge(p, ageMs)
  }
  return { teamDir, inboxesDir }
}

async function setAge(path, ageMs) {
  const t = new Date(NOW - ageMs)
  await utimes(path, t, t)
}

function msg(from, isoTs, text, extra = {}) {
  return { from, text, timestamp: isoTs, read: false, ...extra }
}

async function readInbox(inboxesDir) {
  return JSON.parse(await readFile(join(inboxesDir, 'team-lead.json'), 'utf-8'))
}

const aliveYes = async () => true
const aliveNo = async () => false

function run(overrides = {}) {
  return migrateStrandedInboxes({
    teamsDir: root,
    isOrchestratorAlive: aliveYes,
    nowMs: NOW,
    ...overrides,
  })
}

test('replays only unprocessed messages: after lead activity cutoff, unread, non-control', async () => {
  // Dead source: lead last wrote (dashboard-user.json) 2h ago; messages before that were
  // plausibly delivered, messages after were definitely not.
  await makeTeam('session-dead', {
    configAgeMs: 20 * HOUR,
    leadInbox: [
      msg('dashboard-user', '2026-07-03T20:00:00.000Z', 'processed long ago'),
      msg('scheduler', '2026-07-04T05:00:00.000Z', 'stranded job A'),
      msg('dashboard-user', '2026-07-04T05:30:00.000Z', 'stranded user msg', { extraField: 'kept' }),
      msg('worker-x', '2026-07-04T05:40:00.000Z', '{"type":"idle_notification","from":"worker-x"}'),
      msg('heartbeat', '2026-07-04T05:45:00.000Z', 'heartbeat backlog'),
      { from: 'scheduler', text: 'already read', timestamp: '2026-07-04T05:50:00.000Z', read: true },
    ],
    otherInboxes: { 'dashboard-user.json': { ageMs: 2 * HOUR } },
  })
  const dest = await makeTeam('session-live', { configAgeMs: 0, leadInbox: [] })

  const result = await run()
  assert.equal(result.destination, 'session-live')
  assert.equal(result.total, 2)

  const inbox = await readInbox(dest.inboxesDir)
  assert.equal(inbox.length, 2)
  // Order preserved (original timestamps ascending), fresh delivery timestamps assigned.
  assert.equal(inbox[0].from, 'scheduler')
  assert.match(inbox[0].text, /replayed .* from dead session session-dead/)
  assert.match(inbox[0].text, /stranded job A$/)
  assert.equal(inbox[0].originalTimestamp, '2026-07-04T05:00:00.000Z')
  assert.equal(inbox[0].migratedFrom, 'session-dead')
  assert.equal(inbox[0].read, false)
  assert.equal(Date.parse(inbox[0].timestamp), NOW)
  assert.equal(inbox[1].from, 'dashboard-user')
  assert.equal(inbox[1].extraField, 'kept') // original fields preserved
  assert.equal(Date.parse(inbox[1].timestamp), NOW + 1)
})

test('idempotent: second run migrates nothing (durable marker)', async () => {
  await makeTeam('session-dead', {
    configAgeMs: 20 * HOUR,
    leadInbox: [msg('scheduler', '2026-07-04T05:00:00.000Z', 'stranded job')],
    otherInboxes: { 'dashboard-user.json': { ageMs: 2 * HOUR } },
  })
  const dest = await makeTeam('session-live', { leadInbox: [] })

  const first = await run()
  assert.equal(first.total, 1)
  const second = await run({ nowMs: NOW + 60_000 })
  assert.equal(second.total, 0)
  assert.equal((await readInbox(dest.inboxesDir)).length, 1)
})

test('fail-closed: no live orchestrator process migrates nothing', async () => {
  await makeTeam('session-dead', {
    configAgeMs: 20 * HOUR,
    leadInbox: [msg('scheduler', '2026-07-04T05:00:00.000Z', 'stranded job')],
    otherInboxes: { 'dashboard-user.json': { ageMs: 2 * HOUR } },
  })
  const dest = await makeTeam('session-live', { leadInbox: [] })

  const result = await run({ isOrchestratorAlive: aliveNo })
  assert.equal(result.total, 0)
  assert.equal((await readInbox(dest.inboxesDir)).length, 0)
})

test('legacy fallback team (no config.json): all unread real messages are candidates', async () => {
  // The legacy teams/superbot2 dir never had a session; no cutoff signal exists and
  // everything unread in it was by definition never delivered.
  await makeTeam('superbot2', {
    config: false,
    leadInbox: [
      msg('dashboard-user', '2026-07-04T05:00:00.000Z', 'misdelivered during dead window'),
      { from: 'dashboard-user', text: 'old read one', timestamp: '2026-07-04T04:00:00.000Z', read: true },
    ],
  })
  const dest = await makeTeam('session-live', { leadInbox: [] })

  const result = await run()
  assert.equal(result.total, 1)
  const inbox = await readInbox(dest.inboxesDir)
  assert.match(inbox[0].text, /misdelivered during dead window$/)
})

test('max-age filter drops ancient messages', async () => {
  await makeTeam('session-dead', {
    configAgeMs: 100 * HOUR,
    leadInbox: [
      msg('scheduler', new Date(NOW - 72 * HOUR).toISOString(), 'too old'),
      msg('scheduler', new Date(NOW - 1 * HOUR).toISOString(), 'fresh enough'),
    ],
    otherInboxes: { 'dashboard-user.json': { ageMs: 90 * HOUR } },
  })
  await makeTeam('session-live', { leadInbox: [] })

  const result = await run()
  assert.equal(result.total, 1)
})

test('source with recent lead activity is skipped (possibly live)', async () => {
  await makeTeam('session-maybe-live', {
    configAgeMs: 1 * HOUR,
    leadInbox: [msg('scheduler', new Date(NOW - 60_000).toISOString(), 'fresh msg')],
    otherInboxes: { 'dashboard-user.json': { ageMs: 60_000 } }, // wrote 60s ago
  })
  await makeTeam('session-live', { leadInbox: [] })

  const result = await run()
  assert.equal(result.total, 0)
})

test('destination inbox file missing is created; multiple sources merge in timestamp order', async () => {
  await makeTeam('session-dead-a', {
    configAgeMs: 20 * HOUR,
    leadInbox: [msg('scheduler', '2026-07-04T05:10:00.000Z', 'from A')],
    otherInboxes: { 'dashboard-user.json': { ageMs: 3 * HOUR } },
  })
  await makeTeam('session-dead-b', {
    configAgeMs: 10 * HOUR,
    leadInbox: [msg('dashboard-user', '2026-07-04T05:05:00.000Z', 'from B')],
    otherInboxes: { 'dashboard-user.json': { ageMs: 2 * HOUR } },
  })
  const dest = await makeTeam('session-live', { leadInbox: null }) // no team-lead.json yet

  const result = await run()
  assert.equal(result.total, 2)
  const inbox = await readInbox(dest.inboxesDir)
  assert.match(inbox[0].text, /from B$/) // 05:05 before 05:10 regardless of source
  assert.match(inbox[1].text, /from A$/)
})

test('dry-run reports but writes nothing', async () => {
  const src = await makeTeam('session-dead', {
    configAgeMs: 20 * HOUR,
    leadInbox: [msg('scheduler', '2026-07-04T05:00:00.000Z', 'stranded job')],
    otherInboxes: { 'dashboard-user.json': { ageMs: 2 * HOUR } },
  })
  const dest = await makeTeam('session-live', { leadInbox: [] })

  const result = await run({ dryRun: true })
  assert.equal(result.total, 1)
  assert.equal((await readInbox(dest.inboxesDir)).length, 0)
  // no marker written -> a real run afterwards still migrates
  const real = await run()
  assert.equal(real.total, 1)
  void src
})

test('batch cap keeps the newest messages', async () => {
  const entries = []
  for (let i = 0; i < 5; i++) {
    entries.push(msg('scheduler', new Date(NOW - (10 - i) * 60_000).toISOString(), `job ${i}`))
  }
  await makeTeam('session-dead', {
    configAgeMs: 20 * HOUR,
    leadInbox: entries,
    otherInboxes: { 'dashboard-user.json': { ageMs: 2 * HOUR } },
  })
  const dest = await makeTeam('session-live', { leadInbox: [] })

  const result = await run({ maxBatch: 2 })
  assert.equal(result.total, 2)
  const inbox = await readInbox(dest.inboxesDir)
  assert.match(inbox[0].text, /job 3$/)
  assert.match(inbox[1].text, /job 4$/)
})

test('unparseable destination inbox refuses to clobber', async () => {
  await makeTeam('session-dead', {
    configAgeMs: 20 * HOUR,
    leadInbox: [msg('scheduler', '2026-07-04T05:00:00.000Z', 'stranded job')],
    otherInboxes: { 'dashboard-user.json': { ageMs: 2 * HOUR } },
  })
  const dest = await makeTeam('session-live', { leadInbox: null })
  await writeFile(join(dest.inboxesDir, 'team-lead.json'), '{corrupt')

  const result = await run()
  assert.equal(result.total, 0)
  assert.equal(await readFile(join(dest.inboxesDir, 'team-lead.json'), 'utf-8'), '{corrupt')
})

test('symlink-aliased source inbox is never treated as stranded (no self-replay loop)', async () => {
  // Live incident 2026-07-04 18:39Z: teams/superbot2/inboxes/*.json were compat SYMLINKS
  // into the live team's inboxes. Reading the "dead" team through the symlink made the
  // live inbox's own fresh messages look stranded → they replayed into themselves with a
  // new timestamp every watchdog cycle (infinite nesting). Symlinked sources must be skipped.
  const dest = await makeTeam('session-live', {
    configAgeMs: 0,
    leadInbox: [msg('dashboard-user', new Date(NOW - 60_000).toISOString(), 'fresh live msg')],
  })
  const legacyDir = join(root, 'superbot2', 'inboxes')
  await mkdir(legacyDir, { recursive: true })
  await symlink(
    join(dest.inboxesDir, 'team-lead.json'),
    join(legacyDir, 'team-lead.json'),
  )

  const first = await run()
  assert.equal(first.total, 0)
  // and it stays stable across cycles (the loop was one replay per cycle)
  const second = await run({ nowMs: NOW + 30_000 })
  assert.equal(second.total, 0)
  const inbox = await readInbox(dest.inboxesDir)
  assert.equal(inbox.length, 1)
  assert.equal(inbox[0].text, 'fresh live msg')
})

test('isControlMessage classification', () => {
  assert.equal(isControlMessage(msg('heartbeat', '2026-07-04T05:00:00.000Z', 'x')), true)
  assert.equal(isControlMessage(msg('w', '2026-07-04T05:00:00.000Z', '{"type":"idle_notification"}')), true)
  assert.equal(isControlMessage(msg('w', '2026-07-04T05:00:00.000Z', '{"not":"control"}')), false)
  assert.equal(isControlMessage(msg('w', '2026-07-04T05:00:00.000Z', '{broken json')), false)
  assert.equal(isControlMessage(msg('scheduler', '2026-07-04T05:00:00.000Z', 'Scheduled job due')), false)
})

test('messageId is stable and field-sensitive', () => {
  const a = msg('s', '2026-07-04T05:00:00.000Z', 'text')
  assert.equal(messageId(a), messageId({ ...a }))
  assert.notEqual(messageId(a), messageId({ ...a, text: 'other' }))
})
