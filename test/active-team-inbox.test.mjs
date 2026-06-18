// Unit tests for resolveActiveTeamInboxesDir (dashboard/active-team-inbox.mjs).
//
// Bug (2026-06-18): the dashboard wrote INBOUND user messages (Telegram relay,
// escalation-resolved, card actions) to a hardcoded teams/superbot2/inboxes/team-lead.json.
// The orchestrator now runs under a session-named team (e.g. session-475577c1), so those
// messages landed in a dead inbox it never reads → inbound silently never reached the
// orchestrator. The fix resolves the ACTIVE orchestrator team inbox (the team that has a
// real config.json and is most recently active) per request.
//
// Run: node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveActiveTeamInboxesDir, realFileMtimeMs } from '../dashboard/active-team-inbox.mjs'

function makeTeamsDir() {
  const home = mkdtempSync(join(tmpdir(), 'teams-'))
  return join(home, '.claude', 'teams')
}
function ensureTeam(teamsDir, team) {
  const inboxes = join(teamsDir, team, 'inboxes')
  mkdirSync(inboxes, { recursive: true })
  return { teamDir: join(teamsDir, team), inboxes }
}
function writeFileAt(path, content, epochSec) {
  writeFileSync(path, content)
  if (epochSec != null) utimesSync(path, epochSec, epochSec)
}

test('picks the live (config.json-bearing) team over a stale dir with no config', async () => {
  const teamsDir = makeTeamsDir()
  const now = Math.floor(Date.now() / 1000)
  // Stale 'superbot2' team: NO config.json, only a recently-written team-lead.json full of
  // misdelivered inbound (exactly the bug state).
  const stale = ensureTeam(teamsDir, 'superbot2')
  writeFileAt(join(stale.inboxes, 'team-lead.json'), '[]', now) // newest mtime, but no config
  // Live session team: has config.json.
  const live = ensureTeam(teamsDir, 'session-475577c1')
  writeFileAt(join(live.teamDir, 'config.json'), '{"members":[]}', now - 50)
  writeFileAt(join(live.inboxes, 'team-lead.json'), '[]', now - 50)

  const resolved = await resolveActiveTeamInboxesDir(teamsDir, {
    pinnedTeam: 'superbot2', // legacy default — NOT a pin
    fallbackInboxesDir: join(teamsDir, 'superbot2', 'inboxes'),
  })
  assert.equal(resolved, live.inboxes, 'must resolve the live session team, not the stale superbot2 dir')
})

test('picks the most recently active among multiple live teams', async () => {
  const teamsDir = makeTeamsDir()
  const now = Math.floor(Date.now() / 1000)
  const a = ensureTeam(teamsDir, 'session-A')
  writeFileAt(join(a.teamDir, 'config.json'), '{}', now - 200)
  writeFileAt(join(a.inboxes, 'dashboard-user.json'), '[]', now - 200)
  const b = ensureTeam(teamsDir, 'session-B')
  writeFileAt(join(b.teamDir, 'config.json'), '{}', now - 500)
  writeFileAt(join(b.inboxes, 'dashboard-user.json'), '[]', now) // B's orchestrator wrote most recently

  const resolved = await resolveActiveTeamInboxesDir(teamsDir, { pinnedTeam: '', fallbackInboxesDir: null })
  assert.equal(resolved, b.inboxes, 'freshest dashboard-user activity wins')
})

test('an explicit non-default pinnedTeam overrides auto-detection', async () => {
  const teamsDir = makeTeamsDir()
  const now = Math.floor(Date.now() / 1000)
  const live = ensureTeam(teamsDir, 'session-newer')
  writeFileAt(join(live.teamDir, 'config.json'), '{}', now)
  const pinned = ensureTeam(teamsDir, 'my-fixed-team')
  writeFileAt(join(pinned.teamDir, 'config.json'), '{}', now - 999)

  const resolved = await resolveActiveTeamInboxesDir(teamsDir, {
    pinnedTeam: 'my-fixed-team',
    fallbackInboxesDir: null,
  })
  assert.equal(resolved, pinned.inboxes, 'pinned team wins even if another is newer')
})

test('falls back when no live team exists', async () => {
  const teamsDir = makeTeamsDir()
  // Only a config-less stale dir.
  const stale = ensureTeam(teamsDir, 'superbot2')
  writeFileSync(join(stale.inboxes, 'team-lead.json'), '[]')
  const fallback = join(teamsDir, 'superbot2', 'inboxes')
  const resolved = await resolveActiveTeamInboxesDir(teamsDir, { pinnedTeam: 'superbot2', fallbackInboxesDir: fallback })
  assert.equal(resolved, fallback, 'no config.json anywhere -> fallback')
})

test('realFileMtimeMs rejects symlinks and missing files', async () => {
  const teamsDir = makeTeamsDir()
  const { teamDir } = ensureTeam(teamsDir, 'session-X')
  const real = join(teamDir, 'config.json')
  writeFileSync(real, '{}')
  assert.ok((await realFileMtimeMs(real)) > 0, 'real file -> mtime')
  const link = join(teamDir, 'config-link.json')
  symlinkSync(real, link)
  assert.equal(await realFileMtimeMs(link), null, 'symlink -> null')
  assert.equal(await realFileMtimeMs(join(teamDir, 'nope.json')), null, 'missing -> null')
})

test('a config.json that is a SYMLINK does not qualify a team as live', async () => {
  const teamsDir = makeTeamsDir()
  const now = Math.floor(Date.now() / 1000)
  // Real live team.
  const live = ensureTeam(teamsDir, 'session-real')
  writeFileAt(join(live.teamDir, 'config.json'), '{}', now - 100)
  // Decoy team whose config.json is a symlink (and inbox newer) — must be ignored.
  const decoy = ensureTeam(teamsDir, 'decoy')
  symlinkSync(join(live.teamDir, 'config.json'), join(decoy.teamDir, 'config.json'))
  writeFileAt(join(decoy.inboxes, 'team-lead.json'), '[]', now)

  const resolved = await resolveActiveTeamInboxesDir(teamsDir, { pinnedTeam: '', fallbackInboxesDir: null })
  assert.equal(resolved, live.inboxes, 'symlinked config.json does not make a team "live"')
})
