// Resolve the ACTIVE orchestrator team's inboxes directory.
//
// Why this exists: with TeamCreate unavailable in the current harness, each orchestrator
// session registers under a session-based team name (e.g. 'session-475577c1') instead of a
// fixed 'superbot2'. Inbound user messages (Telegram relay, escalation-resolved, card
// actions) must be written to the LIVE orchestrator's team-lead.json — writing to a
// hardcoded teams/superbot2/inboxes/team-lead.json sends them to a dead inbox the
// orchestrator never reads (silent inbound outage). The live team is the one that has a
// real config.json (only registered teams do; a stale dir that only ever received
// misdelivered inbound has none) and is most recently active.

import { readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'

// mtime (ms) of a REAL (non-symlink) file, else null.
export async function realFileMtimeMs(filePath) {
  try {
    const st = await lstat(filePath)
    if (st.isSymbolicLink() || !st.isFile()) return null
    return st.mtimeMs
  } catch {
    return null
  }
}

// Resolve the active orchestrator team's inboxes dir under `teamsDir`.
// - `pinnedTeam`: if set (and not the legacy 'superbot2' default), forces that team
//   (back-compat / testing override).
// - `fallbackInboxesDir`: returned when no live team is found.
// Among teams with a real config.json, pick the one whose activity is freshest, scored by
// the max mtime of {config.json, inboxes/dashboard-user.json, inboxes/team-lead.json}.
export async function resolveActiveTeamInboxesDir(teamsDir, { pinnedTeam = '', fallbackInboxesDir = null } = {}) {
  if (pinnedTeam && pinnedTeam !== 'superbot2') {
    return join(teamsDir, pinnedTeam, 'inboxes')
  }

  let teamDirs = []
  try {
    teamDirs = await readdir(teamsDir)
  } catch {
    return fallbackInboxesDir
  }

  let best = null // { inboxesDir, score }
  for (const team of teamDirs) {
    const teamDir = join(teamsDir, team)
    const cfgMtime = await realFileMtimeMs(join(teamDir, 'config.json'))
    if (cfgMtime === null) continue // not a live/registered orchestrator team
    const inboxesDir = join(teamDir, 'inboxes')
    const dashMtime = (await realFileMtimeMs(join(inboxesDir, 'dashboard-user.json'))) ?? 0
    const leadMtime = (await realFileMtimeMs(join(inboxesDir, 'team-lead.json'))) ?? 0
    const score = Math.max(cfgMtime, dashMtime, leadMtime)
    if (!best || score > best.score) best = { inboxesDir, score }
  }

  return best ? best.inboxesDir : fallbackInboxesDir
}
