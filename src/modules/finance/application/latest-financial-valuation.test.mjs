import assert from "node:assert/strict";
import test from "node:test";

import { deriveLatestFinancialValuation } from "./latest-financial-valuation.ts";

function row(statementType, reportDate, fiscalPeriod, payload) {
  return { code: "601869.SH", statementType, reportDate, fiscalPeriod, payload, source: "eastmoney", rawR2Key: null, updatedAt: 1 };
}

test("current multiples use the latest disclosed H1 financial report rather than a market-provider PE/PB", () => {
  const incomeRows = [
    row("income", "2026-06-30", "二季度", { NOTICE_DATE: "2026-08-22", dataSource: "financial_report", PARENT_NETPROFIT: 2_429_409_177, TOTAL_OPERATE_INCOME: 6_113_601_229 }),
    row("income", "2025-12-31", "12M", { NOTICE_DATE: "2026-03-28", dataSource: "financial_report", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_annual_income.v1", FISCAL_PERIOD: "12M", PARENT_NETPROFIT: 813_737_266, TOTAL_OPERATE_INCOME: 14_252_103_033 }),
    row("income", "2025-06-30", "二季度", { NOTICE_DATE: "2025-08-30", dataSource: "financial_report", PARENT_NETPROFIT: 144_046_660, TOTAL_OPERATE_INCOME: 3_490_723_764 }),
  ];
  const balanceRows = [row("balance", "2026-06-30", "中报", { NOTICE_DATE: "2026-08-22", dataSource: "financial_report", TOTAL_PARENT_EQUITY: 16_364_360_875 })];
  const cashflowRows = [
    row("cashflow", "2026-06-30", "中报", { NOTICE_DATE: "2026-08-22", dataSource: "financial_report", NETCASH_OPERATE: 1_826_119_111 }),
    row("cashflow", "2025-12-31", "年报", { NOTICE_DATE: "2026-03-28", dataSource: "financial_report", NETCASH_OPERATE: 3_652_897_527 }),
    row("cashflow", "2025-06-30", "中报", { NOTICE_DATE: "2025-08-30", dataSource: "financial_report", NETCASH_OPERATE: 842_247_404 }),
  ];
  const result = deriveLatestFinancialValuation({
    marketCapitalization: 301_026_297_268.8,
    availableAt: "2026-08-23T01:00:37.654Z",
    incomeRows,
    balanceRows,
    cashflowRows,
  });
  assert.equal(result.source, "financial-statements");
  assert.equal(result.basis.income?.reportDate, "2026-06-30");
  assert.equal(result.basis.income?.noticeDate, "2026-08-22");
  assert.equal(Number(result.peTtm?.toFixed(2)), 97.13);
  assert.equal(Number(result.pb?.toFixed(2)), 18.4);
  assert.equal(Number(result.psTtm?.toFixed(2)), 17.84);
  assert.equal(Number(result.pcfTtm?.toFixed(2)), 64.92);
});

test("a fact is unavailable before its disclosure date and no provider multiple is used as a fallback", () => {
  const result = deriveLatestFinancialValuation({
    marketCapitalization: 100,
    availableAt: "2026-08-21T23:59:59.999Z",
    incomeRows: [row("income", "2026-06-30", "二季度", { NOTICE_DATE: "2026-08-22", PARENT_NETPROFIT: 10 })],
    balanceRows: [row("balance", "2026-06-30", "中报", { NOTICE_DATE: "2026-08-22", TOTAL_PARENT_EQUITY: 10 })],
    cashflowRows: [],
  });
  assert.deepEqual(result, {
    source: "financial-statements", peTtm: null, pb: null, psTtm: null, pcfTtm: null,
    basis: { income: null, balance: null, cashflow: null },
  });
});

test("formal financial reports outrank a quick report and forecast for the same disclosed period", () => {
  const result = deriveLatestFinancialValuation({
    marketCapitalization: 1_000,
    availableAt: "2026-12-31T23:59:59.999Z",
    incomeRows: [
      row("income", "2026-12-31", "12M", { NOTICE_DATE: "2026-12-20", dataSource: "performance_forecast", cumulativeParentNetprofit: 10 }),
      row("income", "2026-12-31", "12M", { NOTICE_DATE: "2026-12-21", dataSource: "performance_report", cumulativeParentNetprofit: 20 }),
      row("income", "2026-12-31", "12M", { NOTICE_DATE: "2026-12-22", dataSource: "financial_report", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_annual_income.v1", FISCAL_PERIOD: "12M", PARENT_NETPROFIT: 25 }),
    ],
    balanceRows: [],
    cashflowRows: [],
  });
  assert.equal(result.basis.income?.source, "financial_report");
  assert.equal(result.peTtm, 40);
});
