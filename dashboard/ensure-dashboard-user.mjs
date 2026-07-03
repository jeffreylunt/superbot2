// Ensure `dashboard-user` is a registered member of the ACTIVE orchestrator team's
// config.json — idempotently, every time it's called.
//
// Why this exists: the harness's initializeSessionTeam creates each session team's
// config.json with ONLY `team-lead` in `members` (TeamCreate is unavailable, so the team
// is named session-XXXX and seeded minimally). The orchestrator replies to the user via
// `SendMessage({to: 'dashboard-user'})`, but SendMessage validates the recipient against
// the team's `members` registry (read fresh from config.json on each call). With no
// `dashboard-user` member, every reply is rejected ("No teammate named 'dashboard-user'
// is currently on team ...") and the orchestrator cannot answer Telegram through the
// normal path. After a context-fill restart the team name changes, so this breaks on every
// restart until re-registered.
//
// Fix: add a `dashboard-user` member block to the active team's config.json. Because the
// SendMessage member lookup re-reads config.json (no cache), this takes effect WITHOUT a
// harness restart. It is decoupled from the harness team lifecycle (works under any
// session-XXXX name) and safe to run repeatedly — a no-op once the member is present.
//
// The `dashboard-user` member is a virtual participant (the human via the dashboard /
// Telegram). It is NOT a spawned agent: no tmuxPaneId / backendType, so the harness's
// session-cleanup (which only kills members that have a tmuxPaneId + a real backend) leaves
// it alone, and it never appears as a worker.

import { readFile, writeFile, readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'

const DASHBOARD_USER = 'dashboard-user'

// mtime (ms) of a REAL (non-symlink) regular file, else null. Mirrors active-team-inbox.mjs
// — a symlinked config.json must NOT qualify a team as live (avoids stale band-aid links).
async function realFileMtimeMs(filePath) {
  try {
    const st = await lstat(filePath)
    if (st.isSymbolicLink() || !st.isFile()) return null
    return st.mtimeMs
  } catch {
    return null
  }
}

// Resolve the active orchestrator team DIRECTORY (the one with a real config.json, freshest
// by max mtime of {config.json, dashboard-user.json, team-lead.json}). A non-'superbot2'
// pinnedTeam forces that team. Returns null when no live team is found.
export async function resolveActiveTeamDir(teamsDir, { pinnedTeam = '' } = {}) {
  if (pinnedTeam && pinnedTeam !== 'superbot2') {
    return join(teamsDir, pinnedTeam)
  }
  let teamDirs = []
  try {
    teamDirs = await readdir(teamsDir)
  } catch {
    return null
  }
  let best = null // { teamDir, score }
  for (const team of teamDirs) {
    const teamDir = join(teamsDir, team)
    const cfgMtime = await realFileMtimeMs(join(teamDir, 'config.json'))
    if (cfgMtime === null) continue // not a live/registered orchestrator team
    const inboxesDir = join(teamDir, 'inboxes')
    const dashMtime = (await realFileMtimeMs(join(inboxesDir, 'dashboard-user.json'))) ?? 0
    const leadMtime = (await realFileMtimeMs(join(inboxesDir, 'team-lead.json'))) ?? 0
    const score = Math.max(cfgMtime, dashMtime, leadMtime)
    if (!best || score > best.score) best = { teamDir, score }
  }
  return best ? best.teamDir : null
}

// Build the dashboard-user member block for a given team name.
function dashboardUserMember(teamName) {
  return {
    agentId: `${DASHBOARD_USER}@${teamName}`,
    name: DASHBOARD_USER,
    agentType: DASHBOARD_USER,
    joinedAt: Date.now(),
    cwd: process.env.HOME || '/',
    subscriptions: [],
  }
}

// Ensure `dashboard-user` is a member of the team config at `configPath`.
// Returns one of: 'added' | 'present' | 'no-config' | 'parse-error'.
// Pure file op against an explicit path — used directly by tests.
//
// Concurrency note: the read-modify-rename pattern is atomic with respect to READERS
// (a concurrent reader never sees a partial write), but it is NOT safe against a
// concurrent WRITER (e.g. the harness writing a just-spawned worker's member block
// at the same moment). If both read the same snapshot, one writer's rename will
// silently clobber the other's added member. This race window is narrow (the watchdog
// only calls this once per poll cycle, and the harness rarely mutates config.json at
// exactly the same instant), but callers should be aware that a concurrent harness
// write can lose either dashboard-user or the newly spawned worker's block. Short-
// circuiting the inner watchdog loop once "present" is observed (see telegram-watchdog.sh)
// minimises re-entry and narrows this window further.
export async function ensureDashboardUserInConfig(configPath) {
  let raw
  try {
    raw = await readFile(configPath, 'utf-8')
  } catch {
    return 'no-config'
  }
  let cfg
  try {
    cfg = JSON.parse(raw)
  } catch {
    return 'parse-error'
  }
  if (!cfg || typeof cfg !== 'object') return 'parse-error'
  if (!Array.isArray(cfg.members)) cfg.members = []
  if (cfg.members.some((m) => m && m.name === DASHBOARD_USER)) {
    return 'present'
  }
  const teamName = cfg.name || 'unknown'
  cfg.members.push(dashboardUserMember(teamName))
  // Write atomically (tmp + rename) so a concurrent harness read never sees a partial file.
  const tmp = `${configPath}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf-8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, configPath)
  return 'added'
}

// Resolve the active team and ensure dashboard-user is registered in it.
// Returns { result, teamDir } where result is the ensureDashboardUserInConfig outcome
// (or 'no-team' when no live orchestrator team was found).
export async function ensureDashboardUserRegistered(teamsDir, { pinnedTeam = '' } = {}) {
  const teamDir = await resolveActiveTeamDir(teamsDir, { pinnedTeam })
  if (!teamDir) return { result: 'no-team', teamDir: null }
  const result = await ensureDashboardUserInConfig(join(teamDir, 'config.json'))
  return { result, teamDir }
}
