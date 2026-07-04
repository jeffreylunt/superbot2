// Unit tests for the orchestrator active-wake nudge DECISION logic + pane parsing.
// (dashboard/orchestrator-wake-nudge.mjs). Pure functions only — no tmux/fs side effects.
//
// The nudge is the one risky lever (tmux send-keys into the live orchestrator pane). These
// tests pin every gate so a regression can't make it fire spuriously / submit pending text.
//
// Run: node --test test/orchestrator-wake-nudge.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  titleHasSpinner,
  extractPromptText,
  promptIsEmpty,
  decideNudge,
  tick,
  newestUnreadMs,
  hasUnread,
  UNKNOWN_PROMPT,
} from '../dashboard/orchestrator-wake-nudge.mjs'

const CFG = { graceMs: 30_000, idleQuietMs: 8_000, cooldownMs: 120_000 }
// Base state that PASSES every gate (a genuine stall). Individual tests flip one field.
function passing(overrides = {}) {
  const now = 1_000_000_000
  return {
    nowMs: now,
    newestUnprocessedMs: now - 60_000, // 60s old > grace
    transcriptMtimeMs: now - 600_000, // last turn 10 min ago (idle, and BEFORE the message)
    titleHasSpinner: false,
    promptEmpty: true,
    lastNudgeMs: null,
    ...overrides,
  }
}

// --- titleHasSpinner ---
test('titleHasSpinner detects braille spinner glyphs', () => {
  assert.equal(titleHasSpinner('⠐ Begin coding cycle'), true)
  assert.equal(titleHasSpinner('⠂ Begin coding cycle'), true)
  assert.equal(titleHasSpinner('Begin coding cycle'), false)
  assert.equal(titleHasSpinner(''), false)
  assert.equal(titleHasSpinner(undefined), false)
})

// --- extractPromptText / promptIsEmpty ---
test('extractPromptText reads pending text after the prompt marker', () => {
  const pane = [
    '──────────',
    '❯ Show me the Jedd demo.',
    '──────────',
    '  ⏵⏵ bypass permissions on',
  ].join('\n')
  assert.equal(extractPromptText(pane), 'Show me the Jedd demo.')
  assert.equal(promptIsEmpty(pane), false)
})

test('an empty prompt box is detected as empty', () => {
  const pane = ['──────────', '❯ ', '──────────'].join('\n')
  assert.equal(extractPromptText(pane), '')
  assert.equal(promptIsEmpty(pane), true)
})

// With `capture-pane -e`, the TUI's greyed inline suggestion renders DIM (\x1b[2m).
// Exact bytes observed live 2026-07-03: '\x1b[39m❯\xa0\x1b[2mblock the vrbo calendar
// for those dates\x1b[0m' — arbitrary contextual text that a prefix allowlist can't
// catch. It must read as EMPTY (it blocked real nudges and false-fired the
// stuck-prompt Telegram alert).
test('a DIM-styled inline suggestion counts as empty (escaped capture)', () => {
  const pane = [
    '──────────',
    '\x1b[39m❯ \x1b[2mblock the vrbo calendar for those dates\x1b[0m',
    '──────────',
  ].join('\n')
  assert.equal(extractPromptText(pane), '')
  assert.equal(promptIsEmpty(pane), true)
})

test('real typed text in an escaped capture is still pending text, codes stripped', () => {
  const pane = [
    '──────────',
    '\x1b[39m❯ relay the triage summaries\x1b[0m',
    '──────────',
  ].join('\n')
  assert.equal(extractPromptText(pane), 'relay the triage summaries')
  assert.equal(promptIsEmpty(pane), false)
})

test('a greyed placeholder counts as empty (not pending text)', () => {
  const pane = ['❯ Try "edit <filepath> to make a change"'].join('\n')
  assert.equal(extractPromptText(pane), '')
  assert.equal(promptIsEmpty(pane), true)
})

test('uses the LAST prompt line (live input), not an earlier transcript echo', () => {
  const pane = [
    '❯ an old echoed message in scrollback',
    '──────────',
    '❯ ',
    '──────────',
  ].join('\n')
  assert.equal(extractPromptText(pane), '')
  assert.equal(promptIsEmpty(pane), true)
})

test('missing/garbage pane fails closed (treated as NON-empty)', () => {
  assert.equal(extractPromptText(''), UNKNOWN_PROMPT)
  assert.equal(extractPromptText('no marker here at all'), UNKNOWN_PROMPT)
  assert.equal(promptIsEmpty(''), false)
  assert.equal(promptIsEmpty('no marker here'), false)
})

// --- decideNudge: the happy path ---
test('nudges a genuine stalled backlog when fully idle + empty prompt', () => {
  const r = decideNudge(passing(), CFG)
  assert.equal(r.nudge, true)
  assert.equal(r.reason, 'stalled-backlog')
})

// --- decideNudge: each gate blocks ---
test('no backlog -> no nudge', () => {
  assert.deepEqual(decideNudge(passing({ newestUnprocessedMs: null }), CFG), {
    nudge: false, reason: 'no-backlog',
  })
})

test('fresh message within grace -> no nudge (let the 2s idle poll handle it)', () => {
  const now = 1_000_000_000
  const r = decideNudge(passing({ nowMs: now, newestUnprocessedMs: now - 5_000 }), CFG)
  assert.equal(r.nudge, false)
  assert.equal(r.reason, 'within-grace')
})

test('cooldown active -> no nudge', () => {
  const now = 1_000_000_000
  const r = decideNudge(passing({ nowMs: now, lastNudgeMs: now - 10_000 }), CFG)
  assert.equal(r.nudge, false)
  assert.equal(r.reason, 'cooldown')
})

test('spinner active (turn streaming) -> no nudge', () => {
  const r = decideNudge(passing({ titleHasSpinner: true }), CFG)
  assert.equal(r.nudge, false)
  assert.equal(r.reason, 'spinner-active')
})

test('unknown transcript -> fail closed (no nudge)', () => {
  const r = decideNudge(passing({ transcriptMtimeMs: null }), CFG)
  assert.equal(r.nudge, false)
  assert.equal(r.reason, 'transcript-unknown')
})

test('transcript advanced very recently (turn in flight) -> no nudge', () => {
  const now = 1_000_000_000
  const r = decideNudge(passing({ nowMs: now, transcriptMtimeMs: now - 1_000 }), CFG)
  assert.equal(r.nudge, false)
  assert.equal(r.reason, 'transcript-recent')
})

test('transcript newer than the message (already processed) -> no nudge', () => {
  const now = 1_000_000_000
  // message 60s old, but the orchestrator took a turn 20s ago (after it) — already drained.
  const r = decideNudge(
    passing({ nowMs: now, newestUnprocessedMs: now - 60_000, transcriptMtimeMs: now - 20_000 }),
    CFG,
  )
  assert.equal(r.nudge, false)
  assert.equal(r.reason, 'transcript-after-message')
})

test('prompt has pending user text -> no nudge (never submit it)', () => {
  const r = decideNudge(passing({ promptEmpty: false }), CFG)
  assert.equal(r.nudge, false)
  assert.equal(r.reason, 'prompt-not-empty')
})

// --- ordering: a stall that just cleared cooldown nudges once ---
test('after cooldown elapses, a still-stalled backlog nudges again', () => {
  const now = 1_000_000_000
  const r = decideNudge(passing({ nowMs: now, lastNudgeMs: now - 200_000 }), CFG)
  assert.equal(r.nudge, true)
  assert.equal(r.reason, 'stalled-backlog')
})

// --- newestUnreadMs / hasUnread (review I2: backlog from message fields, not file mtime) ---
test('newestUnreadMs returns the newest UNREAD message timestamp', () => {
  const arr = [
    { read: true, timestamp: '2026-06-28T00:00:30Z' }, // read -> ignored even though newest
    { read: false, timestamp: '2026-06-28T00:00:10Z' },
    { read: false, timestamp: '2026-06-28T00:00:20Z' }, // newest unread
  ]
  assert.equal(newestUnreadMs(arr), Date.parse('2026-06-28T00:00:20Z'))
})

test('newestUnreadMs is null for empty / all-read inboxes', () => {
  assert.equal(newestUnreadMs([]), null)
  assert.equal(newestUnreadMs(null), null)
  assert.equal(newestUnreadMs([{ read: true, timestamp: '2026-06-28T00:00:00Z' }]), null)
})

test('newestUnreadMs treats missing `read` as unread, and is null when no timestamp parses', () => {
  assert.equal(
    newestUnreadMs([{ timestamp: '2026-06-28T00:00:00Z' }]),
    Date.parse('2026-06-28T00:00:00Z'),
    'missing read field => unread',
  )
  assert.equal(newestUnreadMs([{ read: false }]), null, 'unread but no timestamp => null')
  assert.equal(newestUnreadMs([{ read: false, timestamp: 'garbage' }]), null)
})

test('hasUnread reflects presence of any unread message regardless of timestamp', () => {
  assert.equal(hasUnread([]), false)
  assert.equal(hasUnread(null), false)
  assert.equal(hasUnread([{ read: true }]), false)
  assert.equal(hasUnread([{ read: false }]), true) // unread but no timestamp -> still backlog
  assert.equal(hasUnread([{ read: true }, {}]), true) // missing read field => unread
})

// --- tick(): full loop with mock deps (the side-effecting wake path) ---
function mockDeps(overrides = {}) {
  const now = 1_000_000_000
  const calls = { sendNudge: 0, logs: [] }
  const deps = {
    nowMs: () => now,
    readInboxMtimeMs: async () => now - 60_000, // 60s-old backlog
    readTranscriptMtimeMs: async () => now - 600_000, // idle, before the message
    getTitle: async () => 'Begin coding cycle', // no spinner
    capturePane: async () => '──────\n❯ \n──────', // empty prompt
    sendNudge: async () => { calls.sendNudge++ },
    log: (l) => calls.logs.push(l),
    ...overrides,
  }
  return { deps, calls, now }
}

test('tick sends a nudge on a genuine stall and carries lastNudgeMs forward', async () => {
  const { deps, calls, now } = mockDeps()
  const out = await tick(deps, CFG, null)
  assert.equal(out.decision.nudge, true)
  assert.equal(calls.sendNudge, 1)
  assert.equal(out.lastNudgeMs, now, 'cooldown clock starts at this nudge')
  assert.equal(calls.logs.length, 1)
})

test('tick does NOT nudge (and does not call sendNudge) when prompt has pending text', async () => {
  const { deps, calls } = mockDeps({
    capturePane: async () => '❯ Show me the Jedd demo.',
  })
  const out = await tick(deps, CFG, null)
  assert.equal(out.decision.nudge, false)
  assert.equal(out.decision.reason, 'prompt-not-empty')
  assert.equal(calls.sendNudge, 0)
  assert.equal(out.lastNudgeMs, null, 'no nudge -> cooldown clock unchanged')
})

test('tick fails closed when the pane capture fails (capturePane returns null)', async () => {
  const { deps, calls } = mockDeps({ capturePane: async () => null })
  const out = await tick(deps, CFG, null)
  assert.equal(out.decision.nudge, false)
  assert.equal(out.decision.reason, 'prompt-not-empty') // null pane -> promptEmpty false
  assert.equal(calls.sendNudge, 0)
})

test('tick fails closed when the transcript mtime is unknown', async () => {
  const { deps, calls } = mockDeps({ readTranscriptMtimeMs: async () => null })
  const out = await tick(deps, CFG, null)
  assert.equal(out.decision.nudge, false)
  assert.equal(out.decision.reason, 'transcript-unknown')
  assert.equal(calls.sendNudge, 0)
})

test('tick respects cooldown carried from a prior nudge', async () => {
  const { deps, calls, now } = mockDeps()
  const out = await tick(deps, CFG, now - 10_000) // nudged 10s ago, cooldown 120s
  assert.equal(out.decision.nudge, false)
  assert.equal(out.decision.reason, 'cooldown')
  assert.equal(calls.sendNudge, 0)
  assert.equal(out.lastNudgeMs, now - 10_000, 'cooldown clock preserved')
})

test('tick treats a spinner title as mid-turn (no nudge)', async () => {
  const { deps, calls } = mockDeps({ getTitle: async () => '⠹ Begin coding cycle' })
  const out = await tick(deps, CFG, null)
  assert.equal(out.decision.nudge, false)
  assert.equal(out.decision.reason, 'spinner-active')
  assert.equal(calls.sendNudge, 0)
})

// --- boot-dialog detection on ESCAPED captures (live regression 2026-07-04) ---
// capturePaneById captures with -e (SGR escapes, required by the dim-suggestion check).
// The trust dialog styles mid-phrase, so "Enter to confirm" is NOT contiguous in the raw
// capture and healthSnapshot's bootDialog silently reported false — the watchdog never
// auto-confirmed and the orchestrator relaunch-looped at the dialog all night. The fixture
// is the REAL escaped capture of that live dialog. Mirrors healthSnapshot's strip+regexes
// (keep in lockstep with scripts/orchestrator-wake-nudge.mjs healthSnapshot()).
test('boot dialog is detected on an escaped (-e) capture after stripping codes', async () => {
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const raw = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures-boot-dialog-escaped.txt'), 'utf8')
  const BOOT_DIALOG_RE = /Quick safety check|Bypass Permissions mode|WARNING: Claude Code running in Bypass Permissions/i
  const plain = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  // The regression: on the raw capture the phrase check fails.
  assert.equal(/Enter to confirm/.test(raw), false, 'fixture must reproduce the non-contiguous phrase')
  // The fix: after stripping escapes, both checks pass -> bootDialog true.
  assert.ok(BOOT_DIALOG_RE.test(plain), 'dialog phrase detected on stripped capture')
  assert.ok(/Enter to confirm/.test(plain), 'confirm hint detected on stripped capture')
})
