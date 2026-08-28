// Tests for the proc-start live-orchestrator team resolver
// (dashboard/active-team-inbox.mjs).
//
// BUG (measured 2026-08-02, re-measured 2026-08-26 and 2026-08-28): liveOrchestratorTeamDir
// derived the live team dir from the freshest transcript .jsonl FILENAME, which is the CLI
// --session-id. The team dir is named from config.leadSessionId, a HARNESS-INTERNAL uuid that
// appears nowhere on the CLI side. 0 of 12 team dirs matched a transcript on 2026-08-28, so the
// function returned null on every boot and every consumer silently ran on the freshness
// fallback — the exact mechanism the guard existed to replace. Freshness mis-resolves after a
// restart (the new session has no team dir yet, so "freshest" is the PREVIOUS session's), which
// is the documented multi-hour inbound blackout.
//
// The fixture below is the failing case: the transcript-named team is BOTH the freshest AND the
// one the transcript assumption picks, while the live orchestrator's team is the oldest by
// mtime. So a resolver that is right for the wrong reason cannot pass.
//
// Run: node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseEtimeMs,
  orchestratorProcStartMs,
  liveOrchestratorTeamDirByProcStart,
  liveOrchestratorTeamDir,
  resolveActiveTeamInboxesDir,
  procStartResolverEnabled,
  LIVE_TEAM_PROC_START_ENV,
} from '../dashboard/active-team-inbox.mjs'

const ON = { [LIVE_TEAM_PROC_START_ENV]: '1' }
const OFF = {}

// A ps line the module's ORCH_ARGV_RE matches, in the real `-axo pid=,etime=,command=` shape.
function psLine(pid, etime) {
  return `${String(pid).padStart(5)} ${etime} claude --system-prompt-file /Users/jeff/.superbot2/.orchestrator-system-prompt.md --session-id aaaaaaaa-1111-2222-3333-444444444444 --model opus --dangerously-skip-permissions Begin your cycle.`
}
function fakePs(...lines) {
  return async () => ['  501 12:03 /bin/zsh', ...lines, ''].join('\n')
}

const NOW = 1_800_000_000_000
const ETIME = '01:00:00' // 1h
const PROC_START = NOW - 3_600_000

// The transcript uuid. Its first 8 chars name a team dir that EXISTS and is STALE — so any
// resolver that keys on the transcript filename resolves to the wrong (dead) team.
const TRANSCRIPT_UUID = 'aaaaaaaa-1111-2222-3333-444444444444'

function team(teamsDir, name, { createdAt, mtimeSec, leadSessionId }) {
  const teamDir = join(teamsDir, name)
  const inboxes = join(teamDir, 'inboxes')
  mkdirSync(inboxes, { recursive: true })
  const cfg = { name, createdAt, leadAgentId: `team-lead@${name}`, leadSessionId, members: [] }
  const cfgPath = join(teamDir, 'config.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))
  writeFileSync(join(inboxes, 'dashboard-user.json'), '[]')
  writeFileSync(join(inboxes, 'team-lead.json'), '[]')
  for (const p of [cfgPath, join(inboxes, 'dashboard-user.json'), join(inboxes, 'team-lead.json')]) {
    utimesSync(p, mtimeSec, mtimeSec)
  }
  return { teamDir, inboxes, cfgPath }
}

// teams/ + projects/-Users-jeff/<transcript>.jsonl, laid out exactly as the real config dir.
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'livedir-'))
  const teamsDir = join(home, '.claude', 'teams')
  mkdirSync(teamsDir, { recursive: true })
  const projects = join(home, '.claude', 'projects', '-Users-jeff')
  mkdirSync(projects, { recursive: true })
  writeFileSync(join(projects, `${TRANSCRIPT_UUID}.jsonl`), '{}\n')

  const nowSec = Math.floor(NOW / 1000)
  // STALE, but the FRESHEST by mtime and the one the transcript filename names.
  const stale = team(teamsDir, `session-${TRANSCRIPT_UUID.slice(0, 8)}`, {
    createdAt: PROC_START - 30 * 86_400_000,
    mtimeSec: nowSec,
    leadSessionId: TRANSCRIPT_UUID,
  })
  // The LIVE orchestrator's team: created 900ms after the process started, OLDEST by mtime.
  const live = team(teamsDir, 'session-bbbbbbbb', {
    createdAt: PROC_START + 900,
    mtimeSec: nowSec - 5000,
    leadSessionId: 'bbbbbbbb-9999-8888-7777-666666666666',
  })
  // A third dead team, for good measure.
  team(teamsDir, 'session-cccccccc', {
    createdAt: PROC_START - 60 * 86_400_000,
    mtimeSec: nowSec - 100,
    leadSessionId: 'cccccccc-5555-4444-3333-222222222222',
  })
  return { teamsDir, stale, live }
}

const seam = { psRunner: fakePs(psLine(13013, ETIME)), nowMs: NOW }

// --- etime parsing -----------------------------------------------------------

test('parseEtimeMs handles every macOS etime shape', () => {
  assert.equal(parseEtimeMs('05:47'), 347_000)
  assert.equal(parseEtimeMs('20:20:47'), 73_247_000)
  assert.equal(parseEtimeMs('02-20:20:47'), 246_047_000)
  assert.equal(parseEtimeMs('  01:00:00  '), 3_600_000)
})

test('parseEtimeMs returns null on unparseable input', () => {
  // macOS `ps -axo etimes=` fails ("keyword not found") and can yield an empty column;
  // that must degrade to null, never to NaN or 0 (0 would read as "started just now").
  for (const bad of ['', '   ', 'abc', '12', '1:2:3:4', undefined, null]) {
    assert.equal(parseEtimeMs(bad), null, `expected null for ${JSON.stringify(bad)}`)
  }
})

// --- process start -----------------------------------------------------------

test('orchestratorProcStartMs computes start from now - etime', async () => {
  assert.equal(await orchestratorProcStartMs(seam), PROC_START)
})

test('orchestratorProcStartMs takes the NEWEST orchestrator on a relaunch overlap', async () => {
  // Watchdog relaunch: the OLD process is still running. Pinning to its (about to be
  // abandoned) team is the outage shape, so the newest must win.
  const psRunner = fakePs(psLine(1, '10:00:00'), psLine(2, '00:30'), psLine(3, '02:00:00'))
  assert.equal(await orchestratorProcStartMs({ psRunner, nowMs: NOW }), NOW - 30_000)
})

test('orchestratorProcStartMs returns null when no orchestrator is running', async () => {
  assert.equal(await orchestratorProcStartMs({ psRunner: fakePs(), nowMs: NOW }), null)
})

test('orchestratorProcStartMs returns null when ps itself fails', async () => {
  const psRunner = async () => { throw new Error('ps exploded') }
  assert.equal(await orchestratorProcStartMs({ psRunner, nowMs: NOW }), null)
})

// --- THE MUTATION CHECK ------------------------------------------------------

test('MUTATION CHECK: resolves the live team, NOT the team the transcript filename names', async () => {
  const { teamsDir, stale, live } = fixture()
  const got = await liveOrchestratorTeamDirByProcStart(teamsDir, seam)
  assert.equal(got, live.teamDir, 'must resolve the RUNNING orchestrator\'s team')
  // Re-introducing the transcript-filename assumption makes this resolve to `stale`,
  // which exists, is the freshest, and carries a matching leadSessionId — so it would
  // look correct to every other check. This assertion is the only thing that catches it.
  assert.notEqual(got, stale.teamDir, 'transcript-filename assumption has been re-introduced')
})

// --- THE SIDE-BY-SIDE FAILING CASE -------------------------------------------

test('CONTROL: flag OFF resolves to the STALE team; flag ON resolves to the LIVE team', async () => {
  const { teamsDir, stale, live } = fixture()
  const off = await resolveActiveTeamInboxesDir(teamsDir, { ...seam, env: OFF })
  const on = await resolveActiveTeamInboxesDir(teamsDir, { ...seam, env: ON })
  assert.equal(off, stale.inboxes, 'shipped default reproduces the bug on this fixture')
  assert.equal(on, live.inboxes, 'proc-start resolver routes to the live orchestrator')
  assert.notEqual(off, on, 'the two must differ, or this fixture proves nothing')
})

// --- safety: null rather than a wrong answer ---------------------------------

test('returns null when the orchestrator is not running (freshness fallback preserved)', async () => {
  const { teamsDir } = fixture()
  const got = await liveOrchestratorTeamDirByProcStart(teamsDir, { psRunner: fakePs(), nowMs: NOW })
  assert.equal(got, null)
})

test('returns null when NO team qualifies yet (team-not-created-yet window)', async () => {
  // Acceptance criterion 3: the genuine window where the live session has no team dir must
  // still fall through to freshness scoring rather than pinning to a dead team.
  const home = mkdtempSync(join(tmpdir(), 'livedir-'))
  const teamsDir = join(home, '.claude', 'teams')
  mkdirSync(teamsDir, { recursive: true })
  team(teamsDir, 'session-dddddddd', {
    createdAt: PROC_START - 86_400_000,
    mtimeSec: Math.floor(NOW / 1000),
    leadSessionId: 'dddddddd-1111-1111-1111-111111111111',
  })
  assert.equal(await liveOrchestratorTeamDirByProcStart(teamsDir, seam), null)
  // and the caller still gets a mailbox
  const resolved = await resolveActiveTeamInboxesDir(teamsDir, { ...seam, env: ON })
  assert.equal(resolved, join(teamsDir, 'session-dddddddd', 'inboxes'))
})

test('returns null on AMBIGUITY rather than guessing', async () => {
  const { teamsDir } = fixture()
  team(teamsDir, 'session-eeeeeeee', {
    createdAt: PROC_START + 1200,
    mtimeSec: Math.floor(NOW / 1000),
    leadSessionId: 'eeeeeeee-1111-1111-1111-111111111111',
  })
  assert.equal(await liveOrchestratorTeamDirByProcStart(teamsDir, seam), null)
})

test('rejects a config whose name disagrees with its directory', async () => {
  // e.g. a config.json symlinked/copied in from another team — the band-aid-symlink shape.
  const { teamsDir, live } = fixture()
  writeFileSync(live.cfgPath, JSON.stringify({
    name: 'session-somewhere-else',
    createdAt: PROC_START + 900,
    leadAgentId: 'team-lead@session-somewhere-else',
    members: [],
  }))
  assert.equal(await liveOrchestratorTeamDirByProcStart(teamsDir, seam), null)
})

test('rejects a config whose leadAgentId does not match its own name', async () => {
  const { teamsDir, live } = fixture()
  writeFileSync(live.cfgPath, JSON.stringify({
    name: 'session-bbbbbbbb',
    createdAt: PROC_START + 900,
    leadAgentId: 'team-lead@session-cccccccc',
    members: [],
  }))
  assert.equal(await liveOrchestratorTeamDirByProcStart(teamsDir, seam), null)
})

test('rejects a non-numeric or absent createdAt', async () => {
  for (const createdAt of ['2026-08-26T01:17:30.483Z', undefined, null]) {
    const { teamsDir, live } = fixture()
    writeFileSync(live.cfgPath, JSON.stringify({
      name: 'session-bbbbbbbb', createdAt, leadAgentId: 'team-lead@session-bbbbbbbb', members: [],
    }))
    assert.equal(await liveOrchestratorTeamDirByProcStart(teamsDir, seam), null,
      `createdAt=${JSON.stringify(createdAt)} must not qualify`)
  }
})

test('a corrupt config.json is skipped, not fatal', async () => {
  const { teamsDir, live, stale } = fixture()
  writeFileSync(join(stale.teamDir, 'config.json'), '{ not json')
  assert.equal(await liveOrchestratorTeamDirByProcStart(teamsDir, seam), live.teamDir)
})

// --- the flag ----------------------------------------------------------------

test('the env flag is OFF unless explicitly enabled', () => {
  for (const v of [undefined, '', '0', 'false', 'no', 'off']) {
    assert.equal(procStartResolverEnabled({ [LIVE_TEAM_PROC_START_ENV]: v }), false, `v=${v}`)
  }
  for (const v of ['1', 'true', 'yes']) {
    assert.equal(procStartResolverEnabled({ [LIVE_TEAM_PROC_START_ENV]: v }), true, `v=${v}`)
  }
  assert.equal(procStartResolverEnabled({}), false)
})

test('liveOrchestratorTeamDir dispatches on the flag', async () => {
  const { teamsDir, live } = fixture()
  assert.equal(await liveOrchestratorTeamDir(teamsDir, { ...seam, env: ON }), live.teamDir)
  // With the flag off it must NOT return the live team — that is what makes landing this
  // change a provable no-op on the running system.
  assert.notEqual(await liveOrchestratorTeamDir(teamsDir, { ...seam, env: OFF }), live.teamDir)
})
