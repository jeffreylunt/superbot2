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

import { readdir, lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const pexecFile = promisify(execFile)

// --- live-orchestrator session detection -------------------------------------
// Freshness scoring alone mis-resolves after every orchestrator restart: the new session
// has NO team dir until it first uses teams, so "freshest existing dir" is the PREVIOUS
// session's — and every consumer (telegram relay, wake-nudge backlog, migration
// destination, dashboard-user registration) inherits the error until the live team
// appears. Proven live 4x (2026-07-13..16): Jeff's messages orphaned in a dead team
// while the live orchestrator reported "Idle — nothing to process".
//
// Ground truth is the RUNNING orchestrator process: its argv carries --session-id, and
// its team dir (when it exists) is `session-<uuid8>` with config.leadSessionId matching
// the full uuid. If that team dir exists, it IS the active team — no scoring needed.
// If the process is down or its team dir doesn't exist yet, return null and let the
// caller fall back to freshness scoring (a mailbox is better than nowhere; the stranded-
// inbox migration replays once the live team materializes and this preference kicks in).
//
// Liveness: ps -axo + string match on the argv HEAD (survives macOS's argv truncation;
// pgrep -f never matches ANCESTORS of the caller — same caveats as
// migrate-stranded-inbox.mjs). Session identity: the argv TAIL (--session-id) gets
// truncated away by ps, so it is NOT recoverable there — instead use the freshest
// top-level transcript jsonl in the orchestrator config-dir's projects dir, whose
// FILENAME is the session uuid (the same source wake-nudge trusts for turn activity;
// the live session writes its transcript immediately at boot).
const ORCH_ARGV_MARKER = 'claude --system-prompt # Superbot2 Orchestrator'
export async function liveOrchestratorTeamDir(teamsDir) {
  try {
    const { stdout } = await pexecFile('ps', ['-axo', 'command='], { maxBuffer: 64 * 1024 * 1024 })
    if (!stdout.split('\n').some((l) => l.includes(ORCH_ARGV_MARKER))) return null
  } catch {
    return null
  }
  // teams dir lives at <config-dir>/teams; transcripts at <config-dir>/projects/-Users-jeff
  // (the orchestrator always runs with cwd=$HOME — see orchestrator-watchdog relaunch).
  const projectsDir = join(teamsDir, '..', 'projects', '-Users-jeff')
  let sessionUuid = null
  try {
    let best = null
    for (const f of await readdir(projectsDir)) {
      if (!f.endsWith('.jsonl')) continue
      const st = await lstat(join(projectsDir, f))
      if (!st.isFile()) continue
      if (!best || st.mtimeMs > best.mtimeMs) best = { f, mtimeMs: st.mtimeMs }
    }
    if (!best) return null
    sessionUuid = best.f.replace(/\.jsonl$/, '')
  } catch {
    return null
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(sessionUuid)) return null
  const teamDir = join(teamsDir, `session-${sessionUuid.slice(0, 8)}`)
  try {
    // Must be a REGISTERED team (config.json), and belong to this session if the config
    // names a lead session (guards against an unrelated dir with a colliding prefix).
    const cfg = JSON.parse(await readFile(join(teamDir, 'config.json'), 'utf-8'))
    if (cfg.leadSessionId && cfg.leadSessionId !== sessionUuid) return null
    return teamDir
  } catch {
    return null // team dir not created yet — caller falls back to freshness scoring
  }
}

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
// - `scoreLeadInbox`: include inboxes/team-lead.json mtime in the freshness score
//   (default true). team-lead.json is written by OTHER producers (scheduler, Telegram,
//   dashboard), NOT by the team's own lead — so for consumers that need "which team is
//   actually alive" (e.g. the stranded-inbox migration picking a replay DESTINATION),
//   counting it is circular: a dead team keeps looking fresh precisely because of the
//   misdelivered messages we're trying to move out of it. Those callers pass false and
//   score only lead-authored signals (config.json, inboxes/dashboard-user.json).
// Among teams with a real config.json, pick the one whose activity is freshest, scored by
// the max mtime of {config.json, inboxes/dashboard-user.json[, inboxes/team-lead.json]}.
export async function resolveActiveTeamInboxesDir(teamsDir, { pinnedTeam = '', fallbackInboxesDir = null, scoreLeadInbox = true } = {}) {
  if (pinnedTeam && pinnedTeam !== 'superbot2') {
    return join(teamsDir, pinnedTeam, 'inboxes')
  }

  // Ground truth first: the RUNNING orchestrator's own team (see liveOrchestratorTeamDir).
  // Only honored when that team dir exists under THIS teamsDir — so isolated test homes
  // (whose teamsDir never contains the dev machine's real session team) are unaffected.
  const liveDir = await liveOrchestratorTeamDir(teamsDir)
  if (liveDir) return join(liveDir, 'inboxes')

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
    const leadMtime = scoreLeadInbox
      ? ((await realFileMtimeMs(join(inboxesDir, 'team-lead.json'))) ?? 0)
      : 0
    const score = Math.max(cfgMtime, dashMtime, leadMtime)
    if (!best || score > best.score) best = { inboxesDir, score }
  }

  return best ? best.inboxesDir : fallbackInboxesDir
}
