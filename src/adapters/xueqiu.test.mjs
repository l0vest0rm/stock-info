import assert from 'node:assert/strict'
import test from 'node:test'

import { mapXueqiuKlineRows } from './xueqiu.ts'

test('Xueqiu K-line maps PB, PE, and market capital by response column name', () => {
  const rows = mapXueqiuKlineRows({
    data: {
      column: ['close', 'pb', 'timestamp', 'market_capital', 'high', 'open', 'low', 'pe', 'turnoverrate', 'amount', 'percent', 'chg'],
      item: [[10.5, 0.82, 1_785_340_800_000, 123_400_000_000, 10.8, 10.2, 10, 8.6, 1.2, 90_000_000, 2.5, 0.26]],
    },
  }, { code: '600000.SH', period: 'day', fq: 'qfq', updatedAt: 1 })

  assert.equal(rows.length, 1)
  assert.equal(rows[0].date, '2026-07-30')
  assert.equal(rows[0].close, 10.5)
  assert.equal(rows[0].pb, 0.82)
  assert.equal(rows[0].peTtm, 8.6)
  assert.equal(rows[0].marketCapital, 123_400_000_000)
  assert.equal(rows[0].turnover, 1.2)
  assert.equal(rows[0].amount, 90_000_000)
  assert.equal(rows[0].pctChange, 2.5)
  assert.equal(rows[0].changeAmount, 0.26)
})

test('Xueqiu K-line rejects a response without the required named price columns', () => {
  assert.throws(() => mapXueqiuKlineRows({ data: { column: ['timestamp', 'close'], item: [] } }, {
    code: '600000.SH', period: 'day', fq: 'qfq', updatedAt: 1,
  }), /missing required column: open/)
})
