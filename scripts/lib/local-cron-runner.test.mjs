import assert from 'node:assert/strict'
import test from 'node:test'
import {
  dispatchScheduled,
  parseCronExpressions,
  scheduledUrl,
} from '../local-cron-runner.mjs'

test('reads Cloudflare cron triggers from JSONC without duplicating entries', () => {
  const crons = parseCronExpressions(`{
    // Cloudflare cron triggers use UTC.
    "triggers": { "crons": ["*/15 * * * *", "0 19 * * *", "*/15 * * * *"] },
  }`)
  assert.deepEqual(crons, ['*/15 * * * *', '0 19 * * *'])
  assert.throws(
    () => parseCronExpressions('{ "triggers": { "crons": [15] } }'),
    /must be a non-empty string/,
  )
})

test('builds Wrangler scheduled handler URL with cron and scheduled time', () => {
  const url = scheduledUrl('http://127.0.0.1:8000', '0 19 * * *', 123456789)
  assert.equal(url.pathname, '/cdn-cgi/handler/scheduled')
  assert.equal(url.searchParams.get('cron'), '0 19 * * *')
  assert.equal(url.searchParams.get('time'), '123456789')
})

test('dispatches a scheduled event and surfaces HTTP failures', async () => {
  let requestedUrl = ''
  const success = await dispatchScheduled({
    baseUrl: 'http://127.0.0.1:8000',
    cron: '*/15 * * * *',
    scheduledTime: 987654321,
    fetchImpl: async (url) => {
      requestedUrl = String(url)
      return new Response('ok', { status: 200 })
    },
  })
  assert.equal(success.status, 200)
  const request = new URL(requestedUrl)
  assert.equal(request.searchParams.get('cron'), '*/15 * * * *')
  assert.equal(request.searchParams.get('time'), '987654321')

  await assert.rejects(
    dispatchScheduled({
      baseUrl: 'http://127.0.0.1:8000',
      cron: '*/15 * * * *',
      fetchImpl: async () => new Response('broken', { status: 500 }),
    }),
    /HTTP 500: broken/,
  )
})
