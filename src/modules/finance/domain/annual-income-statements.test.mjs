import assert from "node:assert/strict";
import test from "node:test";

import { isFormalAnnualIncomeStatement, selectAnnualIncomeStatements } from "./annual-income-statements.ts";

function incomeRow(overrides = {}) {
  return {
    code: "300308.SZ",
    statementType: "income",
    reportDate: "2025-12-31",
    fiscalPeriod: null,
    payload: {},
    source: "eastmoney",
    rawR2Key: null,
    updatedAt: 1,
    ...overrides,
  };
}

test("annual selector consumes Eastmoney's explicit FY row rather than summing Q1-Q4", () => {
  const rows = [
    incomeRow({ reportDate: "2025-03-31", fiscalPeriod: "一季度", payload: { PARENT_NETPROFIT: 10 } }),
    incomeRow({ reportDate: "2025-06-30", fiscalPeriod: "二季度", payload: { PARENT_NETPROFIT: 20 } }),
    incomeRow({ reportDate: "2025-09-30", fiscalPeriod: "三季度", payload: { PARENT_NETPROFIT: 30 } }),
    incomeRow({ reportDate: "2025-12-31", fiscalPeriod: "四季度", payload: { PARENT_NETPROFIT: 40 } }),
    incomeRow({ fiscalPeriod: "12M", payload: {
      FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_annual_income.v1", FISCAL_PERIOD: "12M", TOTAL_OPERATE_INCOME: 1_000, PARENT_NETPROFIT: 150,
    } }),
  ];
  assert.deepEqual(selectAnnualIncomeStatements(rows).map(({ fiscalYear, revenue, netProfit }) => ({ fiscalYear, revenue, netProfit })), [
    { fiscalYear: 2025, revenue: 1_000, netProfit: 150 },
  ]);
});

test("annual selector does not double-count Eastmoney HK cumulative interim rows", () => {
  const rows = [
    incomeRow({ code: "00700.HK", reportDate: "2025-03-31", payload: { FINANCIAL_SOURCE_CONTRACT: "eastmoney_hk_f10_main_indicator.v1", DATE_TYPE_CODE: "003", TOTAL_OPERATE_INCOME: 25, PARENT_NETPROFIT: 5 } }),
    incomeRow({ code: "00700.HK", reportDate: "2025-06-30", payload: { FINANCIAL_SOURCE_CONTRACT: "eastmoney_hk_f10_main_indicator.v1", DATE_TYPE_CODE: "002", TOTAL_OPERATE_INCOME: 55, PARENT_NETPROFIT: 11 } }),
    incomeRow({ code: "00700.HK", reportDate: "2025-09-30", payload: { FINANCIAL_SOURCE_CONTRACT: "eastmoney_hk_f10_main_indicator.v1", DATE_TYPE_CODE: "004", TOTAL_OPERATE_INCOME: 90, PARENT_NETPROFIT: 18 } }),
    incomeRow({ code: "00700.HK", reportDate: "2025-12-31", payload: { FINANCIAL_SOURCE_CONTRACT: "eastmoney_hk_f10_main_indicator.v1", DATE_TYPE_CODE: "001", TOTAL_OPERATE_INCOME: 130, PARENT_NETPROFIT: 26 } }),
  ];
  assert.deepEqual(selectAnnualIncomeStatements(rows).map(({ revenue, netProfit }) => ({ revenue, netProfit })), [{ revenue: 130, netProfit: 26 }]);
});

test("annual selector distinguishes Yahoo 12M facts from 3M facts at the same end date", () => {
  const base = { code: "BABA.US", reportDate: "2025-03-31", source: "yahoo", payload: { FINANCIAL_SOURCE_CONTRACT: "yahoo_finance_timeseries.v2", REPORTING_CURRENCY: "CNY" } };
  const rows = [
    incomeRow({ ...base, fiscalPeriod: "3M", payload: { ...base.payload, FISCAL_PERIOD: "3M", totalOperateIncome: 100, netProfit: 10 } }),
    incomeRow({ ...base, fiscalPeriod: "12M", payload: { ...base.payload, FISCAL_PERIOD: "12M", totalOperateIncome: 420, netProfit: 42 } }),
  ];
  assert.deepEqual(selectAnnualIncomeStatements(rows).map(({ revenue, netProfit }) => ({ revenue, netProfit })), [{ revenue: 420, netProfit: 42 }]);
});

test("December quarter, provisional rows, and unlabelled rows cannot become annual actuals", () => {
  assert.equal(isFormalAnnualIncomeStatement(incomeRow({ fiscalPeriod: "四季度" })), false);
  assert.equal(isFormalAnnualIncomeStatement(incomeRow({ fiscalPeriod: "12M", source: "eastmoney_performance", payload: { dataSource: "performance_report" } })), false);
  assert.equal(isFormalAnnualIncomeStatement(incomeRow({ reportDate: "2025-12-31" })), false);
});
