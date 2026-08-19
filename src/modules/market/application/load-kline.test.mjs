import assert from 'node:assert/strict'
import test from 'node:test'

import { usesFundNetValueHistory } from './load-kline.ts'

test('routes exchange-traded ETFs to the stock K-line boundary', () => {
  assert.equal(usesFundNetValueHistory('588000.SH'), false)
  assert.equal(usesFundNetValueHistory('159919.SZ'), false)
})

test('keeps off-exchange fund identifiers on Eastmoney NAV history', () => {
  assert.equal(usesFundNetValueHistory('005827.OF'), true)
})
