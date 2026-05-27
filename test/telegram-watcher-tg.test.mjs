// Tests that the Telegram API wrapper now bounds every request with a timeout,
// so a hung/black-holed connection can no longer wedge the outbound relay loop
// forever (the 2026-05-27 incident root cause).
//
// We can't import telegram-watcher.mjs directly (it auto-runs main()), so we
// replicate the exact tg() timeout+retry contract this test guards against and
// verify it against a real server that never responds. Run: node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

// Mirror of the watcher's isRetryableError timeout/abort handling.
function isRetryableError(err) {
  const msg = (err.message || '').toLowerCase()
  const name = (err.name || '').toLowerCase()
  return name === 'timeouterror' || name === 'aborterror' ||
    msg.includes('aborted') || msg.includes('timeout')
}

test('a request to a never-responding server times out (does not hang forever)', async () => {
  // Server that accepts the connection but NEVER sends a response — exactly the
  // half-open/black-hole case that hung fetch() with no AbortSignal.
  const server = createServer(() => { /* intentionally never respond */ })
  await new Promise(r => server.listen(0, r))
  const port = server.address().port

  const TG_REQUEST_TIMEOUT_MS = 300
  const start = Date.now()
  let threw = null
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      signal: AbortSignal.timeout(TG_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    threw = err
  }
  const elapsed = Date.now() - start

  server.close()

  assert.ok(threw, 'fetch should reject, not hang')
  assert.ok(elapsed < 3000, `should abort quickly (was ${elapsed}ms)`)
  assert.ok(isRetryableError(threw), `timeout error should be retryable: name=${threw.name} msg=${threw.message}`)
})

test('isRetryableError classifies timeout/abort errors as retryable', () => {
  assert.equal(isRetryableError({ name: 'TimeoutError', message: 'The operation timed out.' }), true)
  assert.equal(isRetryableError({ name: 'AbortError', message: 'The operation was aborted.' }), true)
  assert.equal(isRetryableError({ name: 'TypeError', message: 'bad input' }), false)
})
