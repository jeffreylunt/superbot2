// Unit tests for scripts/relay-filter.mjs — the rule deciding which orchestrator-outbox
// entries reach Jeff, and the one-time counter translation the widening required.
//
// The counter tests are the load-bearing ones: getting them wrong re-sends already-delivered
// messages to Jeff (duplicate blast) or skips undelivered ones (silent loss, the bug this
// change removes). They are written so that re-introducing the old team-lead-only assumption
// FAILS them — see the mutation check at the bottom.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRelayableReply, labelReplyText, translateReplyCounter } from '../scripts/relay-filter.mjs'

const tl = (text = 'x') => ({ from: 'team-lead', text })
const worker = (name, text = 'x') => ({ from: name, text })

test('isRelayableReply: team-lead still relays (no regression on the path Jeff uses)', () => {
  assert.equal(isRelayableReply(tl()), true)
})

test('isRelayableReply: a worker sender now relays — this is the bug being fixed', () => {
  assert.equal(isRelayableReply(worker('personal-imessage-check-0800')), true)
  assert.equal(isRelayableReply(worker('space-worker')), true)
})

test('isRelayableReply: dashboard-user is excluded — never echo Jeff back at himself', () => {
  assert.equal(isRelayableReply({ from: 'dashboard-user', text: 'hi' }), false)
  assert.equal(isRelayableReply({ from: '  dashboard-user  ', text: 'hi' }), false)
})

test('isRelayableReply: malformed entries are not relayed', () => {
  assert.equal(isRelayableReply(null), false)
  assert.equal(isRelayableReply({}), false)
  assert.equal(isRelayableReply({ from: '' }), false)
  assert.equal(isRelayableReply({ from: '   ' }), false)
  assert.equal(isRelayableReply({ from: 42 }), false)
})

test('labelReplyText: team-lead text is passed through byte-for-byte', () => {
  assert.equal(labelReplyText('team-lead', 'hello'), 'hello')
  // Canary plumbing must survive unchanged if it ever reaches this function.
  assert.equal(labelReplyText('team-lead', '[canary-ack abc123]'), '[canary-ack abc123]')
})

test('labelReplyText: a non-team-lead sender is attributed', () => {
  assert.equal(labelReplyText('vrbo-deadline-0826', 'expires today'), '[vrbo-deadline-0826]\nexpires today')
})

test('labelReplyText: empty text is left empty (never emit a bare label)', () => {
  assert.equal(labelReplyText('some-worker', ''), '')
})

test('translateReplyCounter: nothing delivered stays nothing delivered', () => {
  assert.equal(translateReplyCounter([tl(), tl()], 0), 0)
  assert.equal(translateReplyCounter([], 0), 0)
})

test('translateReplyCounter: an all-team-lead inbox is a no-op (the state it shipped in)', () => {
  // Measured live 2026-08-26: 174 entries, 174 from team-lead, counter 174.
  const inbox = Array.from({ length: 174 }, () => tl())
  assert.equal(translateReplyCounter(inbox, 174), 174)
})

test('translateReplyCounter: worker entries BEFORE the delivered boundary shift the counter', () => {
  // Old rule saw [tl,tl,tl]; counter 2 meant "the first two team-lead entries are delivered",
  // which is absolute index 2. Under the new rule indices 0..2 hold 3 relayable entries.
  const inbox = [tl('a'), worker('w1', 'urgent'), tl('b'), tl('c')]
  assert.equal(translateReplyCounter(inbox, 2), 3)
})

test('translateReplyCounter: worker entries AFTER the boundary are left undelivered', () => {
  // The whole point: w1 sits past the boundary and must still be sent to Jeff.
  const inbox = [tl('a'), tl('b'), worker('w1', 'urgent'), tl('c')]
  const newCount = translateReplyCounter(inbox, 2)
  assert.equal(newCount, 2)
  const relayable = inbox.filter(isRelayableReply)
  assert.deepEqual(relayable.slice(newCount).map((m) => m.text), ['urgent', 'c'])
})

test('translateReplyCounter: a counter ahead of the inbox returns 0, as the old truncation reset did', () => {
  assert.equal(translateReplyCounter([tl(), tl()], 5), 0)
})

test('translateReplyCounter: dashboard-user entries never count as delivered', () => {
  const inbox = [tl('a'), { from: 'dashboard-user', text: 'jeff' }, tl('b')]
  assert.equal(translateReplyCounter(inbox, 2), 2)
})

// MUTATION CHECK. The translation exists only because the two index spaces differ. If someone
// "simplifies" it back to the old team-lead-only assumption (counter unchanged), this must
// fail — otherwise the tests above would pass against the very bug they guard.
test('MUTATION: the old identity translation is rejected by these fixtures', () => {
  const identityTranslation = (_inbox, oldCount) => oldCount
  const inbox = [tl('a'), worker('w1', 'urgent'), tl('b'), tl('c')]
  assert.equal(translateReplyCounter(inbox, 2), 3)
  assert.notEqual(identityTranslation(inbox, 2), translateReplyCounter(inbox, 2))
})

// MUTATION CHECK. If the predicate is reverted to `from === 'team-lead'`, a worker message is
// dropped again. Assert the difference explicitly rather than trusting the predicate tests.
test('MUTATION: the old team-lead-only predicate drops a message this one keeps', () => {
  const oldPredicate = (m) => m && m.from === 'team-lead'
  const urgent = worker('personal-imessage-check-0800', 'Time-critical: needs a reply now')
  assert.equal(oldPredicate(urgent), false)
  assert.equal(isRelayableReply(urgent), true)
})
