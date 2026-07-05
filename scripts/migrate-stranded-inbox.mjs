#!/usr/bin/env node
// CLI for the stranded-inbox migration (see dashboard/inbox-migration.mjs for the design).
// Invoked by orchestrator-watchdog.sh each supervision cycle; safe to run by hand.
//
//   node scripts/migrate-stranded-inbox.mjs [--dry-run] [--verbose]
//
// Quiet on no-op (the watchdog calls it every ~30s); logs only replays, warnings and
// errors unless --verbose. Env overrides:
//   SUPERBOT2_HOME          base dir (default ~/.superbot2)
//   MIGRATE_TEAMS_DIR       teams dir (default $SUPERBOT2_HOME/.claude/teams)
//   MIGRATE_SHADOW_DIR      shadow-snapshot dir (default $SUPERBOT2_HOME/.inbox-shadow)
//   MIGRATE_ALIVE_CMD       liveness probe command (default pgrep for the orchestrator)
//   MIGRATE_MAX_AGE_H       max message age to replay, hours (default 48)
//   MIGRATE_SOURCE_QUIET_S  source team must be quiet this long, seconds (default 600)
//   MIGRATE_MAX_BATCH       max messages per run (default 100)

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  migrateStrandedInboxes,
  snapshotActiveTeamInboxes,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_SOURCE_QUIET_MS,
  DEFAULT_MAX_BATCH,
} from '../dashboard/inbox-migration.mjs'

const HOME_DIR = process.env.SUPERBOT2_HOME || join(homedir(), '.superbot2')
const TEAMS_DIR = process.env.MIGRATE_TEAMS_DIR || join(HOME_DIR, '.claude', 'teams')
const SHADOW_DIR = process.env.MIGRATE_SHADOW_DIR || join(HOME_DIR, '.inbox-shadow')

// Same distinctive argv prefix orchestrator-watchdog.sh matches; the [O] keeps our own
// argv (and other monitors') from matching. ps+grep rather than pgrep -f: macOS pgrep
// never matches an ANCESTOR of the calling process, so a pgrep-based probe run from any
// shell descended from the orchestrator itself (ops sessions, workers) would false-negative
// (verified live 2026-07-04: pgrep exit 1 from a descendant, exit 0 from the tmux server).
const ALIVE_CMD = process.env.MIGRATE_ALIVE_CMD
  || 'ps ax -o command= | grep -q "claude --system-prompt # Superbot2 [O]rchestrator"'

const dryRun = process.argv.includes('--dry-run')
const verbose = process.argv.includes('--verbose') || dryRun

function logLine(msg, level = 'info') {
  if (level === 'debug' && !verbose) return
  console.log(`[${new Date().toISOString()}] inbox-migration: ${msg}`)
}

function aliveProbe() {
  return new Promise((resolve) => {
    execFile('bash', ['-c', ALIVE_CMD], (err) => resolve(!err))
  })
}

// The ps/grep probe reads the orchestrator's ~300KB argv, which macOS intermittently
// fails to return (~0.7%/read — the same glitch behind the watchdog false-DOWN crash
// loop). A false "dead" here is fail-closed (holds one cycle), but retrying makes the
// hold-a-cycle case vanishingly rare.
async function orchestratorAlive() {
  for (let i = 0; i < 3; i++) {
    if (await aliveProbe()) return true
    await new Promise((r) => setTimeout(r, 1500))
  }
  return false
}

try {
  // Shadow first, so the freshest possible copy exists before any rotation deletes the
  // real team dir (the harness removes it on graceful claude exit).
  if (!dryRun) {
    await snapshotActiveTeamInboxes({ teamsDir: TEAMS_DIR, shadowDir: SHADOW_DIR, log: logLine })
  }
  const result = await migrateStrandedInboxes({
    teamsDir: TEAMS_DIR,
    shadowDir: SHADOW_DIR,
    isOrchestratorAlive: orchestratorAlive,
    maxAgeMs: (Number(process.env.MIGRATE_MAX_AGE_H) || DEFAULT_MAX_AGE_MS / 3600e3) * 3600e3,
    sourceQuietMs: (Number(process.env.MIGRATE_SOURCE_QUIET_S) || DEFAULT_SOURCE_QUIET_MS / 1000) * 1000,
    maxBatch: Number(process.env.MIGRATE_MAX_BATCH) || DEFAULT_MAX_BATCH,
    dryRun,
    log: logLine,
  })
  if (result.total > 0) {
    logLine(`${dryRun ? 'would migrate' : 'migrated'} ${result.total} message(s) -> ${result.destination}`)
  } else {
    logLine('nothing to migrate', 'debug')
  }
} catch (err) {
  logLine(`ERROR: ${err.stack || err.message}`, 'error')
  process.exit(1)
}
