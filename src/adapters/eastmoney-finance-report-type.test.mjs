import assert from 'node:assert/strict'
import test from 'node:test'

import { eastmoneyFinanceReportType } from './eastmoney.ts'

test('uses the dedicated Eastmoney financial statement family for bank, broker, insurer and general companies', () => {
  assert.equal(eastmoneyFinanceReportType('income', '000001.SZ'), 'BINCOMEQC')
  assert.equal(eastmoneyFinanceReportType('balance', '601377.SH'), 'SBALANCE')
  assert.equal(eastmoneyFinanceReportType('cashflow', '600000.SH'), 'BCASHFLOW')
  assert.equal(eastmoneyFinanceReportType('cashflow', '601377.SH'), 'SCASHFLOW')
  assert.equal(eastmoneyFinanceReportType('cashflow', '601318.SH'), 'ICASHFLOWQC')
  assert.equal(eastmoneyFinanceReportType('income', '600519.SH'), 'GINCOMEQC')
  assert.equal(eastmoneyFinanceReportType('cashflow', '300308.SZ'), 'GCASHFLOW')
})
