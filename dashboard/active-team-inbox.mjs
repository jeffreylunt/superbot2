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
import { join, basename } from 'node:path'
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
// Ground truth is the RUNNING orchestrator process. Liveness comes from its argv
// (ps -axo + string match on the argv HEAD; survives macOS argv truncation, and pgrep -f
// never matches ANCESTORS of the caller — same caveat as migrate-stranded-inbox.mjs).
// Both argv generations are matched: the legacy inline prompt, and the 2026-08-10
// --system-prompt-file form (see ORCH_PATTERN in orchestrator-watchdog.sh).
const ORCH_ARGV_RE = /claude --system-prompt( # Superbot2 Orchestrator|-file .*\.orchestrator-system-prompt)/
// ANCHORED form, used when we have the command field isolated from ps. ORCH_ARGV_RE is
// unanchored and therefore matches ANY process whose argv merely CONTAINS the pattern —
// observed live 2026-08-28: two `node -e "...ORCH_ARGV_RE source text..."` scanners matched
// themselves and appeared as orchestrators with etime 00:00. Newest-wins would then take
// `now` as the process start and nothing would qualify (fail-safe → null → freshness), but
// the resolver would be silently inert for as long as such a process existed. Anchoring at
// the start of the command kills the whole class. The optional path prefix keeps a
// `/usr/local/bin/claude …` launch working.
export const ORCH_COMMAND_RE = /^(?:\S*\/)?claude --system-prompt( # Superbot2 Orchestrator|-file .*\.orchestrator-system-prompt)/

// ============================================================================
// SESSION IDENTITY: why the transcript-filename derivation below can never work
// ============================================================================
// The original implementation derived the team dir from the freshest top-level transcript
// .jsonl FILENAME, which is the CLI --session-id. That is a DIFFERENT ID SPACE from the one
// the team dir is named after. Measured 2026-08-02 (1 of 9 matched), re-measured 2026-08-26
// (0 of 11) and again 2026-08-28 (0 of 12 — every team dir, no exceptions):
//
//   orchestrator argv          --session-id 1ae1f671-4cc1-4499-b92a-de5653652c0a
//   ~/.superbot2/.orchestrator-session      1ae1f671-…            (same)
//   freshest transcript        1ae1f671-….jsonl                   (same)
//   live team dir              session-58a99d14
//     config.leadSessionId     58a99d14-5984-4fa6-a831-b6ecd471b69f   <- appears NOWHERE else
//
// 58a99d14 exists ONLY as .claude/teams/session-58a99d14 and .claude/tasks/session-58a99d14.
// It is a harness-internal uuid with no CLI-side representative. So the transcript resolver
// computes teams/session-1ae1f671, which does not exist, and returns null at the config read
// — ALWAYS, on every boot. It is not "unreliable", it is inert by construction, and every
// consumer has therefore been silently running on the freshness fallback that this guard was
// written to replace.
//
// ⛔ TWO ROUTES THAT LOOK OBVIOUS AND ARE BOTH DEAD. Do not re-attempt either; both were
// proposed and measured on 2026-08-28.
//
//   (a) "Read --session-id off ps instead of the transcript filename." The comment that used
//       to live here claimed the argv TAIL is truncated away by ps and is therefore not
//       recoverable. THAT CLAIM IS FALSE: `ps -axo command=` prints the full argv including
//       --session-id. But recovering the session id more reliably fixes NOTHING, because no
//       team dir is named from the session id. It is the same id space as the transcript
//       filename. A better source for the wrong key is still the wrong key.
//
//   (b) "Match config.leadSessionId against the orchestrator's --session-id." leadSessionId
//       is SELF-REFERENTIAL: across all 12 team dirs it is always just the dir's own uuid8
//       expanded (session-58a99d14 -> 58a99d14-5984-…). It is not a pointer at the CLI
//       session and never matches --session-id. Verified on every team dir, no exceptions.
//
// So no CLI-side identifier can name the team, and no field on disk links the two. Rather
// than CREATE a link (e.g. having the orchestrator stamp a marker file into its team dir at
// boot — which needs a boot-path change, cannot help the already-running session, and adds a
// new stale/missing-marker failure mode), we correlate on a value both sides already have:
// TIME.
//
// THE REPLACEMENT: correlate the team's config.createdAt with the RUNNING orchestrator's
// process start time. The harness stamps createdAt when it creates the team, ~0.6-1.5s after
// the process starts (measured live 2026-08-26 and 2026-08-28); every team belonging to a
// PREVIOUS session is necessarily older than THIS process's start, by hours to months.
//
// ⚠️ THE RISK THAT GOVERNS THIS CODE. Today the transcript resolver is FAIL-SAFE: it always
// returns null and freshness scoring happens to be right. A resolver that returns a WRONG dir
// pins BOTH directions (inbound dashboard/scheduler AND outbound telegram-watcher) to a dead
// directory — strictly worse than today, and invisible from inside the system. Hence: multiple
// independent acceptance signals, null-on-ambiguity, and an env flag defaulted OFF.

// Parse macOS `ps -o etime` — format [[dd-]hh:]mm:ss — into milliseconds.
// macOS `ps` has NO `etimes` keyword: `ps -axo etimes=` fails with
// "ps: etimes: keyword not found", so elapsed time MUST be parsed from this human format.
// (`lstart` is also available but is locale-sensitive, so it is not used.)
export function parseEtimeMs(etime) {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d{1,2}):(\d{2})$/.exec(String(etime).trim())
  if (!m) return null
  const days = Number(m[1] || 0)
  const hours = Number(m[2] || 0)
  const mins = Number(m[3])
  const secs = Number(m[4])
  return ((((days * 24 + hours) * 60) + mins) * 60 + secs) * 1000
}

// Start time (epoch ms) of the RUNNING orchestrator, or null if none is running.
// `psRunner` / `nowMs` exist purely as an injection seam: without them this function cannot
// be tested except against a live orchestrator, which is why the original shipped untested.
export async function orchestratorProcStartMs({ psRunner = null, nowMs = null } = {}) {
  let stdout
  try {
    stdout = psRunner
      ? await psRunner()
      : (await pexecFile('ps', ['-axo', 'pid=,etime=,command='], { maxBuffer: 64 * 1024 * 1024 })).stdout
  } catch {
    return null
  }
  // Capture `now` AFTER the ps call: etime is sampled by ps, so a pre-call timestamp biases
  // the computed start EARLIER (the permissive direction). Negligible vs 120s, but free.
  const now = nowMs ?? Date.now()
  let newest = null
  for (const line of String(stdout).split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    if (!ORCH_COMMAND_RE.test(m[3])) continue // anchored: see ORCH_COMMAND_RE
    if (Number(m[1]) === process.pid) continue // never count the scanner itself
    const elapsed = parseEtimeMs(m[2])
    if (elapsed === null) continue
    const startMs = now - elapsed
    // Watchdog relaunch overlap can show two orchestrators briefly. Take the NEWEST: the
    // older one's team is about to be abandoned, and pinning to it is the outage shape.
    if (newest === null || startMs > newest) newest = startMs
  }
  return newest
}

// How far BEFORE the process start a team's createdAt may sit and still be accepted.
// Slack for clock granularity only — the real separation between the live team and every
// dead one is hours-to-months, so this bound is not load-bearing at its exact value.
export const LIVE_TEAM_PROC_START_TOLERANCE_MS = 120_000

// Upper bound. A team created BY a running process cannot have been created in the future,
// so anything beyond now+skew is impossible and must be rejected.
//
// 🔴 WHY THIS EXISTS (code review, 2026-08-28). Without it the predicate was unbounded above
// AND used `typeof === 'number'`, which ADMITS Infinity: JSON.parse('{"createdAt":1e999}')
// yields Infinity, typeof 'number', and `Infinity >= procStart - 120s` is true FOREVER — across
// every restart. Since the other three clauses are satisfied by construction by any
// harness-written config, one poisoned dir becomes a permanent candidate. It bites hardest in
// the window the docstring promises is safe (team-not-created-yet), where the real team is
// absent and the poisoned dir is therefore the SOLE candidate, so candidates.length === 1
// returns it and pins BOTH directions to a dead dir. Reachable by clock skew, an NTP step
// after sleep/wake, a config restored from backup, or a hand edit.
//
// "No upper bound is deliberate" justifies createdAt >> procStart (a session may create its
// team late). It does NOT justify createdAt >> now. That bound is free.
export const LIVE_TEAM_MAX_FUTURE_MS = 120_000

// GROUND TRUTH: the live orchestrator's team dir, resolved by correlating team
// config.createdAt with the running orchestrator's process start. Returns null when the
// orchestrator is down, when no team qualifies (the genuine team-not-created-yet window),
// or when the answer is AMBIGUOUS — in every one of those cases the caller falls back to
// freshness scoring. Returning null is always safe; returning a wrong dir is not.
// Memo for the log-on-change above; declared before its user to avoid a TDZ-shaped trap.
let lastAcceptedTeamDir
export async function liveOrchestratorTeamDirByProcStart(teamsDir, { psRunner = null, nowMs = null } = {}) {
  const procStart = await orchestratorProcStartMs({ psRunner, nowMs })
  if (procStart === null) return null // orchestrator not running
  const now = nowMs ?? Date.now()

  let entries = []
  try {
    entries = await readdir(teamsDir)
  } catch {
    return null
  }

  const candidates = []
  for (const name of entries) {
    const teamDir = join(teamsDir, name)
    const cfgPath = join(teamDir, 'config.json')
    // A SYMLINKED config.json must not qualify a team as live — same stance the freshness
    // scorer takes, for the same band-aid-symlink reason.
    if ((await realFileMtimeMs(cfgPath)) === null) continue
    let cfg
    try {
      cfg = JSON.parse(await readFile(cfgPath, 'utf-8'))
    } catch {
      continue // not a registered team (or unreadable/corrupt config)
    }
    if (!cfg || typeof cfg !== 'object') continue
    // ⚠️ BE HONEST ABOUT WHAT THESE ARE. There is exactly ONE discriminating signal here —
    // time — plus three WELL-FORMEDNESS guards. Do not read the list as four independent
    // witnesses; it is one witness with three sanity checks:
    //   (a) name === basename   well-formedness: rejects a config.json symlinked/copied in
    //                           from another team (the band-aid-symlink failure mode).
    //   (b) leadAgentId         well-formedness: derived FROM cfg.name, so it is not
    //                           independent of (a) — it only rejects a malformed or
    //                           hand-written config that does not follow the convention.
    //   (c) typeof createdAt    a type guard, not an identity signal at all.
    //   (d) createdAt vs procStart   THE discriminator. Everything rests on this.
    // What compensates for resting on a single signal is the null-on-ambiguity rule below,
    // not the length of this list.
    //
    // The band is [procStart - 120s, ∞). Measured 2026-08-28 across all 12 team dirs: the
    // live team sits at +0.0h and the NEAREST dead team at -35.08h, so the 120s slack would
    // have to grow ~1000x before it changed any verdict. The slack is for clock granularity,
    // it is NOT a tuned threshold, and the frequently-quoted "createdAt lands 0.6-1.5s after
    // process start" is n=1 — an observation, never relied on as a bound.
    if (cfg.name !== basename(teamDir)) continue
    if (cfg.leadAgentId !== 'team-lead@' + cfg.name) continue
    // Number.isFinite, NOT typeof: rejects Infinity and NaN. See LIVE_TEAM_MAX_FUTURE_MS.
    if (!Number.isFinite(cfg.createdAt)) continue
    if (cfg.createdAt > now + LIVE_TEAM_MAX_FUTURE_MS) continue // physically impossible
    // No UPPER bound is applied, deliberately: a session may not create its team until it
    // first uses teams, so "createdAt is much later than process start" is legitimate. It is
    // safe because we correlate against the NEWEST running orchestrator — nothing else on
    // the machine creates team dirs, so a team newer than that instant is necessarily its own.
    if (cfg.createdAt < procStart - LIVE_TEAM_PROC_START_TOLERANCE_MS) continue
    candidates.push(teamDir)
  }

  // Exactly one, or nothing. An ambiguous answer must never be guessed — see the risk note.
  const accepted = candidates.length === 1 ? candidates[0] : null
  // The governing risk is that a wrong pin is "invisible from inside the system". Log the
  // acceptance ON CHANGE (not every call — this runs on a poll loop) so the canary is
  // readable from OUTSIDE, in each of the four consumer processes' logs.
  if (accepted !== lastAcceptedTeamDir) {
    lastAcceptedTeamDir = accepted
    console.error(`[active-team-inbox] proc-start resolver -> ${accepted ?? 'null (falling back to freshness scoring)'}`)
  }
  return accepted
}

// ⚠️ THIS IS THE SHIPPED DEFAULT while SUPERBOT2_LIVE_TEAM_BY_PROC_START is off — it is the
// code path governing PRODUCTION routing right now, for every consumer. It is also known to
// return null in practice on every boot (0 of 12 team dirs match; see the SESSION IDENTITY
// block), which is why the system runs entirely on freshness scoring. Both things are true at
// once. DO NOT DELETE IT as dead code until the flag is on in every consumer process.
export async function liveOrchestratorTeamDirByTranscript(teamsDir, { psRunner = null } = {}) {
  try {
    // psRunner seam added 2026-08-28: without it this path silently shells out to the HOST's
    // real ps even from inside an isolated test home, so a test exercising the flag-OFF branch
    // passed for a DIFFERENT reason depending on whether the dev machine had an orchestrator
    // running. Anchored match for the same self-match reason as ORCH_COMMAND_RE.
    const stdout = psRunner
      ? await psRunner()
      : (await pexecFile('ps', ['-axo', 'pid=,etime=,command='], { maxBuffer: 64 * 1024 * 1024 })).stdout
    const alive = String(stdout).split('\n').some((l) => {
      const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l)
      return m ? ORCH_COMMAND_RE.test(m[3]) : false
    })
    if (!alive) return null
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

// Env flag gating the proc-start resolver. Defaults OFF so that landing this change is a
// PROVABLE no-op on the running system: with the flag unset, liveOrchestratorTeamDir behaves
// exactly as it did before (returns null, callers fall back to freshness scoring). Flip it on
// for one canary cycle, confirm a MATCHED canary ack, then change this default.
export const LIVE_TEAM_PROC_START_ENV = 'SUPERBOT2_LIVE_TEAM_BY_PROC_START'

export function procStartResolverEnabled(env) {
  // `??` not a default param: a caller passing null must still fall through to process.env.
  const v = (env ?? process.env)?.[LIVE_TEAM_PROC_START_ENV]
  return v === '1' || v === 'true' || v === 'yes'
}

// Ground-truth live team dir, or null (caller falls back to freshness scoring).
export async function liveOrchestratorTeamDir(teamsDir, { env, psRunner = null, nowMs = null } = {}) {
  if (procStartResolverEnabled(env)) {
    return liveOrchestratorTeamDirByProcStart(teamsDir, { psRunner, nowMs })
  }
  return liveOrchestratorTeamDirByTranscript(teamsDir, { psRunner })
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
// - `env` / `psRunner` / `nowMs`: injection seam forwarded to liveOrchestratorTeamDir.
// Among teams with a real config.json, pick the one whose activity is freshest, scored by
// the max mtime of {config.json, inboxes/dashboard-user.json[, inboxes/team-lead.json]}.
export async function resolveActiveTeamInboxesDir(teamsDir, { pinnedTeam = '', fallbackInboxesDir = null, scoreLeadInbox = true, env, psRunner = null, nowMs = null } = {}) {
  if (pinnedTeam && pinnedTeam !== 'superbot2') {
    return join(teamsDir, pinnedTeam, 'inboxes')
  }

  // Ground truth first: the RUNNING orchestrator's own team (see liveOrchestratorTeamDir).
  // Only honored when that team dir exists under THIS teamsDir — so isolated test homes
  // (whose teamsDir never contains the dev machine's real session team) are unaffected.
  const liveDir = await liveOrchestratorTeamDir(teamsDir, { env, psRunner, nowMs })
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
