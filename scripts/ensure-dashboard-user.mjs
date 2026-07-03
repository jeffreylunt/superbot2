#!/usr/bin/env node
// CLI: ensure `dashboard-user` is a registered member of the ACTIVE orchestrator team's
// config.json. See dashboard/ensure-dashboard-user.mjs for the why.
//
// Invoked as a periodic backstop by the telegram watchdog (and once at launcher startup)
// so the orchestrator's SendMessage({to:'dashboard-user'}) reply path self-heals on every
// session-team change, with no manual step.
//
// Env:
//   SUPERBOT2_HOME  — superbot2 home (default ~/.superbot2)
//   SUPERBOT2_NAME  — if set and != 'superbot2', pins that fixed team
// Exit code is always 0 (best-effort backstop; never abort a supervisor loop). Logs the
// outcome to stderr only when it actually CHANGES the registry (to keep watchdog logs quiet).

import { join } from 'node:path'
import { homedir } from 'node:os'
import { ensureDashboardUserRegistered } from '../dashboard/ensure-dashboard-user.mjs'

const SUPERBOT2_NAME = process.env.SUPERBOT2_NAME || 'superbot2'
const SUPERBOT_DIR = process.env.SUPERBOT2_HOME || join(homedir(), `.${SUPERBOT2_NAME}`)
const TEAMS_DIR = join(SUPERBOT_DIR, '.claude', 'teams')

try {
  const { result, teamDir } = await ensureDashboardUserRegistered(TEAMS_DIR, {
    pinnedTeam: SUPERBOT2_NAME,
  })
  // Only log on a real change so the 15s watchdog poll doesn't spam the log.
  if (result === 'added') {
    process.stderr.write(`ensure-dashboard-user: registered dashboard-user in ${teamDir}\n`)
  } else if (result === 'parse-error') {
    process.stderr.write(`ensure-dashboard-user: config.json parse error in ${teamDir} — skipped\n`)
  }
} catch (err) {
  process.stderr.write(`ensure-dashboard-user: error: ${err?.message || err}\n`)
}
process.exit(0)
