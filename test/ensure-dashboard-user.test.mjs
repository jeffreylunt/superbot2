// Unit tests for ensure-dashboard-user.mjs.
//
// Bug (2026-06-25): after a context-fill restart the orchestrator registers under a NEW
// session team whose config.json `members` contains ONLY team-lead. The orchestrator's
// reply path `SendMessage({to:'dashboard-user'})` is then rejected ("No teammate named
// 'dashboard-user'..."), so it cannot answer Telegram. This module re-registers
// dashboard-user into the ACTIVE team's config.json, idempotently, decoupled from the
// harness team name.
//
// Run: node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveActiveTeamDir,
  ensureDashboardUserInConfig,
  ensureDashboardUserRegistered,
} from '../dashboard/ensure-dashboard-user.mjs'

function makeTeamsDir() {
  const home = mkdtempSync(join(tmpdir(), 'teams-'))
  return join(home, '.claude', 'teams')
}
function ensureTeam(teamsDir, team) {
  const inboxes = join(teamsDir, team, 'inboxes')
  mkdirSync(inboxes, { recursive: true })
  return { teamDir: join(teamsDir, team), inboxes }
}
function writeAt(path, content, epochSec) {
  writeFileSync(path, content)
  if (epochSec != null) utimesSync(path, epochSec, epochSec)
}
function teamLeadOnlyConfig(name) {
  return JSON.stringify({
    name,
    members: [{ agentId: `team-lead@${name}`, name: 'team-lead', agentType: 'team-lead' }],
  })
}

test('adds dashboard-user when missing; idempotent on re-run', async () => {
  const teamsDir = makeTeamsDir()
  const { teamDir } = ensureTeam(teamsDir, 'session-abc12345')
  const cfgPath = join(teamDir, 'config.json')
  writeFileSync(cfgPath, teamLeadOnlyConfig('session-abc12345'))

  const r1 = await ensureDashboardUserInConfig(cfgPath)
  assert.equal(r1, 'added')
  const cfg1 = JSON.parse(readFileSync(cfgPath, 'utf-8'))
  const du = cfg1.members.find((m) => m.name === 'dashboard-user')
  assert.ok(du, 'dashboard-user member present')
  assert.equal(du.agentId, 'dashboard-user@session-abc12345')
  assert.equal(du.agentType, 'dashboard-user')
  // No tmuxPaneId/backendType -> harness session-cleanup won't try to kill it as a worker.
  assert.equal(du.tmuxPaneId, undefined)
  assert.equal(du.backendType, undefined)
  assert.equal(cfg1.members.length, 2, 'team-lead + dashboard-user')

  const r2 = await ensureDashboardUserInConfig(cfgPath)
  assert.equal(r2, 'present', 're-run is a no-op')
  const cfg2 = JSON.parse(readFileSync(cfgPath, 'utf-8'))
  assert.equal(cfg2.members.filter((m) => m.name === 'dashboard-user').length, 1, 'no duplicate member')
})

test('preserves existing members (does not clobber team-lead or workers)', async () => {
  const teamsDir = makeTeamsDir()
  const { teamDir } = ensureTeam(teamsDir, 'session-keepers')
  const cfgPath = join(teamDir, 'config.json')
  writeFileSync(
    cfgPath,
    JSON.stringify({
      name: 'session-keepers',
      leadSessionId: 'keep-me',
      members: [
        { agentId: 'team-lead@session-keepers', name: 'team-lead', agentType: 'team-lead' },
        { agentId: 'worker-1@session-keepers', name: 'worker-1', agentType: 'space-worker', tmuxPaneId: 'in-process' },
      ],
    })
  )
  await ensureDashboardUserInConfig(cfgPath)
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'))
  assert.equal(cfg.leadSessionId, 'keep-me', 'top-level fields untouched')
  assert.ok(cfg.members.find((m) => m.name === 'team-lead'))
  assert.ok(cfg.members.find((m) => m.name === 'worker-1'))
  assert.ok(cfg.members.find((m) => m.name === 'dashboard-user'))
  assert.equal(cfg.members.length, 3)
})

test('no-config when the file is absent; parse-error on garbage', async () => {
  const teamsDir = makeTeamsDir()
  const { teamDir } = ensureTeam(teamsDir, 'session-empty')
  assert.equal(await ensureDashboardUserInConfig(join(teamDir, 'config.json')), 'no-config')
  const bad = join(teamDir, 'config.json')
  writeFileSync(bad, '{not json')
  assert.equal(await ensureDashboardUserInConfig(bad), 'parse-error')
})

test('resolveActiveTeamDir picks freshest live team, ignores config-less stale dir', async () => {
  const teamsDir = makeTeamsDir()
  const now = Math.floor(Date.now() / 1000)
  const stale = ensureTeam(teamsDir, 'superbot2') // no config.json
  writeAt(join(stale.inboxes, 'team-lead.json'), '[]', now)
  const live = ensureTeam(teamsDir, 'session-live')
  writeAt(join(live.teamDir, 'config.json'), '{}', now - 30)
  const resolved = await resolveActiveTeamDir(teamsDir, { pinnedTeam: 'superbot2' })
  assert.equal(resolved, live.teamDir)
})

test('resolveActiveTeamDir ignores a symlinked config.json', async () => {
  const teamsDir = makeTeamsDir()
  const now = Math.floor(Date.now() / 1000)
  const live = ensureTeam(teamsDir, 'session-real')
  writeAt(join(live.teamDir, 'config.json'), '{}', now - 100)
  const decoy = ensureTeam(teamsDir, 'decoy')
  symlinkSync(join(live.teamDir, 'config.json'), join(decoy.teamDir, 'config.json'))
  writeAt(join(decoy.inboxes, 'team-lead.json'), '[]', now)
  const resolved = await resolveActiveTeamDir(teamsDir, { pinnedTeam: '' })
  assert.equal(resolved, live.teamDir, 'symlinked config does not qualify a team')
})

test('end-to-end: ensureDashboardUserRegistered registers into the resolved active team', async () => {
  const teamsDir = makeTeamsDir()
  const now = Math.floor(Date.now() / 1000)
  // An older live team and a newer live team; registration must land in the NEWER one.
  const older = ensureTeam(teamsDir, 'session-older')
  writeAt(join(older.teamDir, 'config.json'), teamLeadOnlyConfig('session-older'), now - 500)
  const newer = ensureTeam(teamsDir, 'session-newer')
  writeAt(join(newer.teamDir, 'config.json'), teamLeadOnlyConfig('session-newer'), now)

  const { result, teamDir } = await ensureDashboardUserRegistered(teamsDir, { pinnedTeam: '' })
  assert.equal(result, 'added')
  assert.equal(teamDir, newer.teamDir)
  const newerCfg = JSON.parse(readFileSync(join(newer.teamDir, 'config.json'), 'utf-8'))
  assert.ok(newerCfg.members.find((m) => m.name === 'dashboard-user'), 'registered in newer team')
  const olderCfg = JSON.parse(readFileSync(join(older.teamDir, 'config.json'), 'utf-8'))
  assert.ok(!olderCfg.members.find((m) => m.name === 'dashboard-user'), 'older team untouched')
})

test('end-to-end: no-team when no live orchestrator team exists', async () => {
  const teamsDir = makeTeamsDir()
  ensureTeam(teamsDir, 'superbot2') // config-less stale dir only
  const { result, teamDir } = await ensureDashboardUserRegistered(teamsDir, { pinnedTeam: 'superbot2' })
  assert.equal(result, 'no-team')
  assert.equal(teamDir, null)
})
