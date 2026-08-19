import assert from 'node:assert/strict'
import test from 'node:test'
import { latestKlinePrice } from './latest-kline-price.ts'

test('prefers the latest stock close', () => {
  assert.deepEqual(latestKlinePrice([
    { date: '2026-08-17', close: 98.2 },
    { date: '2026-08-18', close: 101.5 },
  ]), { price: 101.5, date: '2026-08-18', source: 'close' })
})

test('does not accept a fund NAV payload as an exchange-traded price', () => {
  assert.equal(latestKlinePrice([
    { date: '2026-08-18', nav: 1.8908, accumNav: 1.3131 },
  ]), null)
})
