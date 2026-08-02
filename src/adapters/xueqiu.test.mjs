import assert from 'node:assert/strict'
import test from 'node:test'

import { createXueqiuKlineRequest, mapXueqiuKlineRows } from './xueqiu.ts'

test('uses the licai Xueqiu K-line request profile', () => {
  const request = createXueqiuKlineRequest('SZ300308', 'day', 'qfq', '2026-08-02', 'session=cookie')
  const url = new URL(request.url)

  assert.equal(url.origin + url.pathname, 'https://stock.xueqiu.com/v5/stock/chart/kline.json')
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    symbol: 'SZ300308',
    begin: '1785715200000',
    period: 'day',
    type: 'before',
    count: '-7500',
    indicator: 'kline,pe,pb,ps,pcf,market_capital,agt,ggt,balance',
  })
  assert.deepEqual(request.headers, {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    Cookie: 'session=cookie',
    Referer: 'https://xueqiu.com/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  })
})

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
