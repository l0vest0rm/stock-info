// Retained assertion coverage; all domain computations execute in native Rust.
import { callRustSelftest } from './lib/rust-analysis.mjs';
/**
 * Verify the native production fiscal-calendar selector and TTM arithmetic.
 * An explicit annual row survives a same-date Q4 row; absence remains null.
 * Run after npm run build:rust: node scripts/check-ttm-annual-base-selftest.mjs
 */
import assert from "node:assert/strict";

const ANNUAL_CONTRACT = "eastmoney_f10_annual_income.v1";
const isAnnual = (row) => row.payload.FINANCIAL_SOURCE_CONTRACT === ANNUAL_CONTRACT;

const row = (reportDate, payload) => ({ code: "TEST", statementType: "income", reportDate, fiscalPeriod: payload.FISCAL_PERIOD ?? null, payload });

// Run the production Rust fiscal-calendar selector, not a JS reproduction.
const annualBaseFor = (rows, beforeDate) => callRustSelftest('annualBaseFor', rows, beforeDate);
const ttmNetProfit = rows => callRustSelftest('ttmNetProfit', rows);

// Eastmoney shape: 12-31 twice.  The Q4 row is listed first so a naive
// "first row wins" dedupe would drop the annual statement.
const rows = [
  row("2026-06-30", { PARENT_NETPROFIT: 7.92 }),
  row("2025-12-31", { PARENT_NETPROFIT: 3.67, REPORT_TYPE: "四季度" }),
  row("2025-12-31", { PARENT_NETPROFIT: 10.80, FISCAL_PERIOD: "12M", FINANCIAL_SOURCE_CONTRACT: ANNUAL_CONTRACT }),
  row("2025-06-30", { PARENT_NETPROFIT: 2.41 }),
  row("2024-12-31", { PARENT_NETPROFIT: 4.10, REPORT_TYPE: "四季度" }),
  row("2024-12-31", { PARENT_NETPROFIT: 11.90, FISCAL_PERIOD: "12M", FINANCIAL_SOURCE_CONTRACT: ANNUAL_CONTRACT }),
];

// Q4 rows exist for the fiscal year ends to prove the annual row still wins.
const expected = 10.80 + 7.92 - 2.41;
assert.ok(Math.abs(ttmNetProfit(rows) - expected) < 1e-9, "TTM must use the annual base, not the Q4 row");
assert.equal(annualBaseFor(rows, "2026-06-30").payload.PARENT_NETPROFIT, 10.80);

// Without the annual row the result must degrade to null instead of using Q4 as FY.
assert.equal(ttmNetProfit(rows.filter((item) => !isAnnual(item))), null);

console.log("ttm-annual-base self-test: ok", { ttmNetProfit: ttmNetProfit(rows) });
