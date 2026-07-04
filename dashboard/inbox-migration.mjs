// Stranded-inbox migration — move unprocessed team-lead messages from DEAD session teams
// into the LIVE session's inbox, so nothing is ever stranded by a session rotation.
//
// WHY THIS EXISTS
// ---------------
// Every inbound producer (dashboard POST /api/messages, Telegram relay, scheduler,
// heartbeat, worker SendMessage) appends to the ACTIVE team's inboxes/team-lead.json.
// When the orchestrator session dies and a new one starts, the new session registers a
// brand-new team dir with an EMPTY inbox — anything still sitting unprocessed in the old
// team's inbox (or written to it during the dead window, since dead teams keep their
// config.json and can win the freshest-team resolution until the new team registers) is
// stranded forever. Proven live 2026-07-03/04: Jeff's Telegram messages and three 16:00Z
// scheduler jobs died with session-6c2ebbda / session-a9cbfaa6.
//
// HARNESS FACTS THE DESIGN RESTS ON (verified, see knowledge/orchestrator-wake-mechanism.md)
// - Inbox files are APPEND-ONLY; the harness never sets read:true and never deletes
//   entries. The InboxPoller tracks a private delivered-cursor. So the read flag CANNOT
//   tell us what was processed (we still skip read:true defensively).
// - A team's leadSessionId does NOT reliably map to a transcript file (sessions get
//   resumed under new ids), so transcripts can't provide a per-team cutoff either.
// - The ONLY writer of a team's non-team-lead inbox files (dashboard-user.json + worker
//   inboxes) is that team's lead. Their max mtime = the lead's LAST SIGN OF LIFE.
//
// THE CUTOFF HEURISTIC
// Messages that arrived AFTER the source team's last sign of life were definitely never
// delivered (delivery only happens at a turn start, and a turn would have produced some
// outbound write eventually — conservative in the not-double-deliver direction: a message
// that arrived shortly BEFORE death may be skipped, but a processed one is never replayed
// unless the lead processed it silently with zero outbound activity afterwards).
//
// DELIVERY SEMANTICS: at-least-once. The destination write lands BEFORE the dedup marker
// is persisted; a crash in between could replay once more on the next run. That trade is
// deliberate — losing a message is the disease this module cures.
//
// Replayed entries get a fresh timestamp (now + seq). The InboxPoller must see them as
// NEW appends, and the wake-nudge computes backlog age from message timestamps — an old
// timestamp could suppress or confuse both. The original timestamp is preserved in the
// text annotation and in originalTimestamp.

import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { resolveActiveTeamInboxesDir } from './active-team-inbox.mjs'

export const DEFAULT_MAX_AGE_MS = 48 * 3600 * 1000
export const DEFAULT_SOURCE_QUIET_MS = 10 * 60 * 1000
export const DEFAULT_MAX_BATCH = 100

const MARKER_BASENAME = '.inbox-migration-state.json'

export function messageId(m) {
  return createHash('sha256')
    .update(`${m.from ?? ''}|${m.timestamp ?? ''}|${m.text ?? ''}`)
    .digest('hex')
}

// Control/ephemeral chatter that must NOT be replayed into a new session: heartbeats are
// regenerated every 30 min, and JSON control envelopes (idle_notification,
// shutdown_approved, ...) reference agents of the dead session.
export function isControlMessage(m) {
  if (!m || typeof m !== 'object') return true
  if (m.from === 'heartbeat' || m.type) return true
  const text = (m.text || '').trim()
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && parsed.type) return true
    } catch { /* not JSON — a real message */ }
  }
  return false
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return null
  }
}

// tmp+rename so concurrent readers never see torn JSON. (Concurrent WRITERS still do
// read-modify-write like every other inbox producer — same accepted system-wide race.)
async function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
  await rename(tmp, path)
}

async function fileMtimeMs(path) {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

// Last write by the SOURCE team's lead: max mtime across inboxes/*.json EXCEPT
// team-lead.json (which other producers append to, including after death) and dotfiles.
// 0 when the team never wrote anything (e.g. the legacy fallback dir) — then every
// unread entry is a candidate.
async function lastLeadActivityMs(inboxesDir) {
  let names = []
  try {
    names = await readdir(inboxesDir)
  } catch {
    return 0
  }
  let newest = 0
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'team-lead.json' || name.startsWith('.')) continue
    const mtime = await fileMtimeMs(join(inboxesDir, name))
    if (mtime !== null && mtime > newest) newest = mtime
  }
  return newest
}

function annotate(m, sourceTeam, nowMs) {
  const stamp = new Date(nowMs).toISOString()
  return (
    `[replayed ${stamp} from dead session ${sourceTeam} — originally sent ` +
    `${m.timestamp}; delivery was delayed by a session restart, so this may be stale: ` +
    `use judgment before acting]\n\n${m.text || ''}`
  )
}

// Main entry. Returns a summary { destination, migrated: [{sourceTeam, count}], total }.
// Fail-closed: any precondition miss (no live orchestrator, no registered team,
// unparseable destination inbox) migrates nothing.
export async function migrateStrandedInboxes({
  teamsDir,
  isOrchestratorAlive,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  sourceQuietMs = DEFAULT_SOURCE_QUIET_MS,
  maxBatch = DEFAULT_MAX_BATCH,
  dryRun = false,
  log = () => {},
}) {
  const none = { destination: null, migrated: [], total: 0 }
  if (!(await isOrchestratorAlive())) {
    log('no live orchestrator process — nothing to migrate into, holding', 'debug')
    return none
  }

  // scoreLeadInbox:false — the replay DESTINATION must be the team that is actually
  // alive. team-lead.json mtime is producer noise (often the very stranded messages
  // this module exists to move), so exclude it from the freshness score here.
  const destInboxesDir = await resolveActiveTeamInboxesDir(teamsDir, { scoreLeadInbox: false })
  if (!destInboxesDir) {
    log('no registered team found — holding', 'debug')
    return none
  }
  const destTeamDir = dirname(destInboxesDir)
  const destTeam = basename(destTeamDir)
  const destInboxPath = join(destInboxesDir, 'team-lead.json')

  let teamNames = []
  try {
    teamNames = await readdir(teamsDir)
  } catch {
    return none
  }

  // Collect candidates per source team, then deliver in one ordered batch.
  const perSource = []
  for (const team of teamNames.sort()) {
    if (team === destTeam) continue
    const teamDir = join(teamsDir, team)
    const inboxesDir = join(teamDir, 'inboxes')
    const leadPath = join(inboxesDir, 'team-lead.json')

    // A SYMLINKED team-lead.json is a compat ALIAS of another (usually the live) team's
    // inbox — e.g. teams/superbot2/inboxes/*.json -> teams/session-<live>/inboxes/*.json,
    // installed so legacy-path writers still reach the live orchestrator. It is NOT a
    // stranded dead-team inbox. Reading through it makes the destination's own fresh
    // messages look stranded and replays them into themselves — an infinite self-feeding
    // annotation loop (observed live 2026-07-04 18:39–18:42Z, one nesting per watchdog
    // cycle). Only REAL files are candidate sources; same-inode as the destination is
    // also excluded as defense against hardlinks/aliasing.
    let leadStat
    try { leadStat = await lstat(leadPath) } catch { continue }
    if (!leadStat.isFile()) {
      log(`source ${team} team-lead.json is not a regular file (symlink alias?) — skipping`, 'debug')
      continue
    }
    try {
      const destStat = await stat(destInboxPath)
      if (destStat.dev === leadStat.dev && destStat.ino === leadStat.ino) {
        log(`source ${team} team-lead.json IS the destination inbox (aliased) — skipping`, 'debug')
        continue
      }
    } catch { /* destination may not exist yet — fine */ }

    const inbox = await readJson(leadPath)
    if (!Array.isArray(inbox) || inbox.length === 0) continue

    const lastLeadMs = await lastLeadActivityMs(inboxesDir)
    if (nowMs - lastLeadMs < sourceQuietMs) {
      log(`source ${team} shows lead activity ${Math.round((nowMs - lastLeadMs) / 1000)}s ago — possibly live, skipping this round`, 'debug')
      continue
    }

    const markerPath = join(teamDir, MARKER_BASENAME)
    const marker = (await readJson(markerPath)) || { migrated: {} }

    const candidates = []
    for (const m of inbox) {
      if (!m || m.read === true || isControlMessage(m)) continue
      const ts = m.timestamp ? Date.parse(m.timestamp) : NaN
      if (Number.isNaN(ts)) continue
      if (ts <= lastLeadMs) continue // plausibly already delivered to the dead session
      if (nowMs - ts > maxAgeMs) continue
      const id = messageId(m)
      if (marker.migrated[id]) continue
      candidates.push({ m, ts, id })
    }
    if (candidates.length === 0) continue
    perSource.push({ team, teamDir, markerPath, marker, candidates })
  }

  let all = perSource
    .flatMap(({ team, candidates }) => candidates.map((c) => ({ ...c, team })))
    .sort((a, b) => a.ts - b.ts)
  if (all.length > maxBatch) {
    log(`capping replay batch: ${all.length} candidates > ${maxBatch}, keeping the newest ${maxBatch}`, 'warn')
    all = all.slice(-maxBatch)
  }
  if (all.length === 0) return { destination: destTeam, migrated: [], total: 0 }

  const kept = new Set(all.map((c) => c.id))
  for (const c of all) {
    log(`replaying [${c.team}] ${c.m.from} @ ${c.m.timestamp}: ${JSON.stringify((c.m.text || '').slice(0, 100))}${dryRun ? ' (dry-run)' : ''}`)
  }
  if (dryRun) {
    return {
      destination: destTeam,
      migrated: perSource.map((s) => ({ sourceTeam: s.team, count: s.candidates.filter((c) => kept.has(c.id)).length })),
      total: all.length,
    }
  }

  // Deliver: single read-append-write of the destination inbox.
  const existingRaw = await readFile(destInboxPath, 'utf-8').catch(() => null)
  let existing = []
  if (existingRaw !== null) {
    try {
      existing = JSON.parse(existingRaw)
      if (!Array.isArray(existing)) throw new Error('not an array')
    } catch {
      log(`destination inbox ${destInboxPath} is unparseable — refusing to clobber it`, 'error')
      return none
    }
  }
  let seq = 0
  for (const c of all) {
    existing.push({
      ...c.m,
      text: annotate(c.m, c.team, nowMs),
      timestamp: new Date(nowMs + seq++).toISOString(),
      read: false,
      migratedFrom: c.team,
      originalTimestamp: c.m.timestamp,
    })
  }
  await mkdir(destInboxesDir, { recursive: true })
  await writeJsonAtomic(destInboxPath, existing)

  // Persist dedup markers AFTER delivery (at-least-once, see header).
  const migrated = []
  for (const s of perSource) {
    const delivered = s.candidates.filter((c) => kept.has(c.id))
    if (delivered.length === 0) continue
    for (const c of delivered) {
      s.marker.migrated[c.id] = { to: destTeam, at: new Date(nowMs).toISOString(), from: c.m.from, originalTimestamp: c.m.timestamp }
    }
    await writeJsonAtomic(s.markerPath, s.marker)
    migrated.push({ sourceTeam: s.team, count: delivered.length })
    log(`migrated ${delivered.length} stranded message(s) ${s.team} -> ${destTeam}`)
  }
  return { destination: destTeam, migrated, total: all.length }
}
