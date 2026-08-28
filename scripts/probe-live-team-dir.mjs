#!/usr/bin/env node
// READ-ONLY probe: what each live-team resolver says about the CURRENTLY RUNNING orchestrator.
// Writes nothing, signals nothing, restarts nothing. Run it before and after flipping
// SUPERBOT2_LIVE_TEAM_BY_PROC_START, and whenever inbound/outbound routing is suspect.
//
//   node scripts/probe-live-team-dir.mjs
//
// The verdict compares the proc-start resolver against an INDEPENDENT witness: the team whose
// config.json most recently gained a member. Agreement is not proof on its own — the freshness
// fallback is usually right too — so the probe prints all three answers rather than one.

import { readdir, readFile, lstat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  orchestratorProcStartMs,
  liveOrchestratorTeamDirByProcStart,
  liveOrchestratorTeamDirByTranscript,
  resolveActiveTeamInboxesDir,
  LIVE_TEAM_PROC_START_ENV,
  procStartResolverEnabled,
  ORCH_COMMAND_RE,
} from '../dashboard/active-team-inbox.mjs'

const pexecFile = promisify(execFile)
const CONFIG_DIR = process.env.SUPERBOT2_DIR || join(homedir(), '.superbot2')
const TEAMS_DIR = join(CONFIG_DIR, '.claude', 'teams')

const rel = (p) => (p ? p.replace(TEAMS_DIR + '/', '') : String(p))

const procStart = await orchestratorProcStartMs()
console.log('teams dir           ', TEAMS_DIR)
console.log('orchestrator start  ', procStart ? new Date(procStart).toISOString() : 'NOT RUNNING')
try {
  const { stdout } = await pexecFile('ps', ['-axo', 'pid=,etime=,command='], { maxBuffer: 64 * 1024 * 1024 })
  // IMPORT the matcher, never re-declare it here. A probe carrying its own copy drifts from
  // the module and then reports agreement while the module disagrees — which is the exact
  // failure a probe exists to prevent. (This copy was already stale once: it kept the
  // UNANCHORED pattern after the module moved to the anchored one.)
  for (const l of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l)
    if (m && ORCH_COMMAND_RE.test(m[3])) console.log('orchestrator argv   ', l.trim().slice(0, 120))
  }
} catch { /* best effort */ }

const byProc = await liveOrchestratorTeamDirByProcStart(TEAMS_DIR)
const byTrans = await liveOrchestratorTeamDirByTranscript(TEAMS_DIR)
const off = await resolveActiveTeamInboxesDir(TEAMS_DIR, { env: {} })
const on = await resolveActiveTeamInboxesDir(TEAMS_DIR, { env: { [LIVE_TEAM_PROC_START_ENV]: '1' } })

console.log()
console.log('stage 1, transcript (LEGACY, shipped default) ', rel(byTrans))
console.log('stage 1, proc-start  (behind the env flag)    ', rel(byProc))
console.log('resolveActiveTeamInboxesDir, flag OFF         ', rel(off))
console.log('resolveActiveTeamInboxesDir, flag ON          ', rel(on))
console.log('flag in THIS process                          ', procStartResolverEnabled() ? 'ON' : 'OFF')

// PARTIALLY independent witness: the most recently WRITTEN config.json. The harness rewrites
// it on every agent spawn, so the live team's mtime moves and a dead team's never does.
// ⚠️ Be precise about how independent this is: it is the mtime of the SAME FILE the resolver
// reads createdAt out of. It is independent of inbox freshness and of createdAt's VALUE, but
// it is not a wholly separate source. The genuinely independent check is the members list —
// a live team contains agents spawned today. Note agent NAMES are recycled across sessions,
// so only date-stamped names are usable as evidence.
let witness = null
for (const name of await readdir(TEAMS_DIR).catch(() => [])) {
  const cfgPath = join(TEAMS_DIR, name, 'config.json')
  try {
    const st = await lstat(cfgPath)
    if (st.isSymbolicLink() || !st.isFile()) continue
    const cfg = JSON.parse(await readFile(cfgPath, 'utf-8'))
    if (!witness || st.mtimeMs > witness.mtimeMs) {
      witness = { dir: join(TEAMS_DIR, name), mtimeMs: st.mtimeMs, members: cfg.members?.length ?? 0 }
    }
  } catch { /* not a registered team */ }
}
console.log()
console.log('witness (newest config.json write, partially independent)', witness ? `${basename(witness.dir)} (members=${witness.members}, ${new Date(witness.mtimeMs).toISOString()})` : 'none')

console.log()
if (!procStart) {
  console.log('VERDICT: no orchestrator running — every resolver correctly declines; freshness fallback governs.')
} else if (!byProc) {
  console.log('VERDICT: proc-start resolver declined (no team yet, or ambiguous). Freshness fallback governs — same as today.')
} else if (witness && byProc === witness.dir) {
  console.log('VERDICT: proc-start resolver AGREES with the independent witness ->', basename(byProc))
  if (off !== on) console.log('         ⚠️  but flag OFF routes elsewhere:', rel(off), '— flipping the flag WOULD change routing.')
  else console.log('         flag OFF and ON agree, so flipping the flag is a no-op right now.')
} else {
  console.log('🔴 VERDICT: proc-start resolver DISAGREES with the independent witness.')
  console.log('   proc-start:', rel(byProc), ' witness:', witness ? basename(witness.dir) : 'none')
  console.log('   DO NOT enable the flag until this is understood.')
}

// ---------------------------------------------------------------------------
// STRANDED USER MESSAGES — the one signal that survives when every resolver is wrong
//
// Costs one directory walk. An unread message whose `from` is dashboard-user is a USER
// message nobody answered, wherever it physically sits. It does not depend on knowing which
// team is live, which is exactly why it still works when the resolvers disagree.
//
// `migrationHops >= 1` AND still unread is a SELF-DECLARING FAILURE: the stranded-inbox
// migration already rescued that message once and delivered it into another dead inbox, then
// recorded the job as done. Nothing in the codebase currently reads that counter.
console.log()
console.log('--- unread dashboard-user messages across ALL team inboxes ---')
let stranded = 0
for (const name of await readdir(TEAMS_DIR).catch(() => [])) {
  for (const box of ['team-lead.json', 'dashboard-user.json']) {
    const p = join(TEAMS_DIR, name, 'inboxes', box)
    let entries
    try {
      const st = await lstat(p)
      if (st.isSymbolicLink() || !st.isFile()) continue
      entries = JSON.parse(await readFile(p, 'utf-8'))
    } catch { continue }
    if (!Array.isArray(entries)) continue
    for (const m of entries) {
      if (m?.from !== 'dashboard-user' || m?.read) continue
      stranded++
      const hops = m.migrationHops ?? 0
      console.log(`  ${name}/${box}`)
      console.log(`    from=${m.from} timestamp=${m.timestamp} read=${m.read}`)
      if (hops) {
        console.log(`    🔴 migrationHops=${hops} migratedFrom=${m.migratedFrom} originalTimestamp=${m.originalTimestamp}`)
        console.log('       ^ already rescued once and delivered into another dead inbox')
      }
      console.log(`    text: ${String(m.text ?? '').replace(/\s+/g, ' ').slice(0, 110)}`)
    }
  }
}
console.log(stranded === 0 ? '  none' : `  ${stranded} unread user message(s) stranded`)
