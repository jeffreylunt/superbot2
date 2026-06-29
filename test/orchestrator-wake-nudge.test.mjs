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
