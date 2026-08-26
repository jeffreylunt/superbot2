// Which entries in the orchestrator's outbox (`<teamdir>/inboxes/dashboard-user.json`) the
// Telegram relay forwards to Jeff, and the one-time counter translation that widening the
// rule required.
//
// Lives in scripts/ (not dashboard/) on purpose: telegram-watcher.mjs static-imports it, and
// a sibling in the same deploy unit cannot go missing independently of the watcher itself.
// A dynamic import with a fallback would be worse here — the only available fallback is the
// old team-lead-only rule, i.e. silently re-introducing the bug this module exists to fix.
//
// WHY THIS EXISTS
// The rule used to be `from === 'team-lead'`, applied at three sites in telegram-watcher.mjs
// (anchor bookkeeping, the relay itself, the startup truncation sync) and once in
// dashboard/server.js. A WORKER's message was therefore written to the inbox, returned
// {success:true} to the sender, and reached nobody — not Telegram, not the dashboard chat.
// Three messages explicitly labelled time-critical died that way; two expired unseen
// (superbot2-app/stability-upgrades task-2026-08-19T14-11-44Z).
//
// WHY WIDENING IS THE ONLY CORRECT FIX
// The alternative — keep the filter and rewrite the job specs — cannot be made correct.
// Measured 2026-08-26: all 29 specs that mention dashboard-user carry a `space` field,
// including two the orchestrator ran ITSELF. Nothing in a spec records whether the
// orchestrator or a worker will execute it, and the same line is correct or fatal depending
// purely on that. There is no field to condition on, so no wording works for both.
//
// Routing intent is unchanged by this module: workers still report to team-lead, who curates
// and relays. This is the safety net for the escape hatch the specs already gate to genuinely
// time-critical items — not the intended path.

// `dashboard-user` is the RECIPIENT of this inbox. An entry claiming to be from them would
// echo Jeff's own words back at him, so it is the one sender excluded.
const NON_RELAY_SENDERS = new Set(['dashboard-user'])

export function isRelayableReply(m) {
  if (!m || typeof m.from !== 'string') return false
  const from = m.from.trim()
  return from.length > 0 && !NON_RELAY_SENDERS.has(from)
}

// Label a reply that did not come from team-lead, so Jeff can see who is talking. Returns the
// text unchanged for team-lead (the overwhelming majority) — no cosmetic change to the
// channel he already reads.
export function labelReplyText(from, text) {
  if (!text || typeof from !== 'string' || from.trim() === 'team-lead') return text
  return `[${from.trim()}]\n${text}`
}

// ONE-TIME COUNTER TRANSLATION.
//
// `lastSentReplyCount` indexes the FILTERED array, not the raw inbox. Widening the rule
// admits worker-authored entries that sit at EARLIER indices, so every index after them
// shifts and the persisted counter would land on messages already delivered — re-sending the
// tail to Jeff. That is the duplicate-blast the switch-reset logic guards against elsewhere.
//
// Translate once: find the absolute inbox index of the last team-lead entry we delivered
// under the OLD rule, then count how many entries at or before it are relayable under the NEW
// rule.
//
// Measured on the day this shipped (2026-08-26): the live inbox held 174 entries, 174 of them
// from team-lead, counter 174 — so the translation was provably a no-op. It is insurance for
// the day it isn't, which is any day after a worker writes there.
export function translateReplyCounter(inbox, oldCount) {
  if (!Array.isArray(inbox) || !(oldCount > 0)) return 0
  let seen = 0
  let absIdx = -1
  for (let i = 0; i < inbox.length; i++) {
    if (inbox[i] && inbox[i].from === 'team-lead') {
      seen++
      if (seen === oldCount) { absIdx = i; break }
    }
  }
  // Counter is ahead of the inbox — the inbox was truncated/recreated. The old code detected
  // exactly this and reset to 0 so the new inbox is forwarded once; return 0 to reproduce
  // that, rather than inventing a value the old rule would never have produced.
  if (absIdx === -1) return 0
  let newCount = 0
  for (let i = 0; i <= absIdx; i++) if (isRelayableReply(inbox[i])) newCount++
  return newCount
}
