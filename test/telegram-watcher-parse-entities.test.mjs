// Tests the outbound "can't parse entities" fallback: when the orchestrator's
// reply produces malformed HTML (e.g. interleaved <b>/<i> from overlapping
// markdown), Telegram rejects the ENTIRE message with a non-retryable 400 and
// the user previously got silence. sendMessage now catches that specific error
// and resends the message as plain text so it always gets delivered.
//
// We can't import telegram-watcher.mjs directly (it auto-runs main()), so we
// mirror the exact htmlToPlainText + fallback contract and verify it against a
// fake Telegram server. Run: node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

// --- Mirrors of the watcher's helpers (kept in lockstep with telegram-watcher.mjs) ---
function htmlToPlainText(text) {
  return text
    .replace(/<\/?(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|blockquote|span|tg-spoiler)(?:\s[^>]*)?>/gi, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}
function isParseEntitiesError(err) {
  return (err?.message || '').toLowerCase().includes("can't parse entities")
}

// Fake Telegram: rejects any HTML-parse-mode send with the real error string,
// accepts a plain send (no parse_mode). `chatNotFound` mode always 400s with an
// unrelated error to prove non-parse errors are NOT swallowed by the fallback.
function startFakeTelegram(mode = 'parseError') {
  const seen = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      const json = JSON.parse(body)
      seen.push(json)
      res.setHeader('content-type', 'application/json')
      if (mode === 'chatNotFound') {
        return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }))
      }
      if ('parse_mode' in json) {
        return res.end(JSON.stringify({
          ok: false, error_code: 400,
          description: 'Bad Request: can\'t parse entities: Unmatched end tag at byte offset 42, expected "</i>", found "</b>"',
        }))
      }
      res.end(JSON.stringify({ ok: true, result: { message_id: 123 } }))
    })
  })
  return { server, seen }
}

// Mirror of sendMessage's send+fallback (single-attempt tg, no network retries needed here).
async function sendWithFallback(url, text) {
  const body = { chat_id: 1, text, parse_mode: 'HTML' }
  const call = async b => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
    const j = await res.json()
    if (!j.ok) throw new Error(`Telegram API sendMessage failed: ${j.description}`)
    return j.result
  }
  try {
    return await call(body)
  } catch (err) {
    if (!isParseEntitiesError(err)) throw err
    const { parse_mode, ...plain } = body
    plain.text = htmlToPlainText(text)
    return call(plain)
  }
}

test('malformed HTML send falls back to plain text and delivers', async () => {
  const { server, seen } = startFakeTelegram('parseError')
  await new Promise(r => server.listen(0, r))
  const url = `http://127.0.0.1:${server.address().port}/`
  try {
    const result = await sendWithFallback(url, '<b>bold <i>both</b> italic</i> and <code>x&lt;y</code>')
    assert.equal(result.message_id, 123, 'message was ultimately delivered')
    assert.equal(seen.length, 2, 'exactly one HTML attempt + one plain-text retry')
    assert.ok('parse_mode' in seen[0], 'first attempt used HTML parse_mode')
    assert.ok(!('parse_mode' in seen[1]), 'retry dropped parse_mode')
    assert.equal(seen[1].text, 'bold both italic and x<y', 'retry text is clean plain text (tags stripped, entities decoded)')
  } finally {
    server.close()
  }
})

test('non-parse errors are NOT swallowed by the fallback', async () => {
  const { server, seen } = startFakeTelegram('chatNotFound')
  await new Promise(r => server.listen(0, r))
  const url = `http://127.0.0.1:${server.address().port}/`
  try {
    await assert.rejects(
      () => sendWithFallback(url, '<b>hi</b>'),
      /chat not found/,
      'a non-parse-entity error must propagate, not fall back',
    )
    assert.equal(seen.length, 1, 'no plain-text retry for unrelated errors')
  } finally {
    server.close()
  }
})
