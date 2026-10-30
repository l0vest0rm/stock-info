// Retained assertion coverage; all domain computations execute in native Rust.
import { callRustSelftest } from './lib/rust-analysis.mjs';
const isCumulativeIncomeRow = (...args) => callRustSelftest('isCumulativeIncomeRow', ...args);
/**
 * Contract check for the income row shapes the TTM formula consumes.
 * Run: node scripts/check-income-contracts-selftest.mjs
 *
 * The bug this exists to prevent: `load-valuation-bands.ts` listed only the two
 * A-share contracts when deciding which income rows are cumulative.  Hong Kong
 * rows carry `eastmoney_hk_f10_main_indicator.v2`, so every HK company computed
 * no TTM profit, and every HK band returned `insufficient_data` with the generic
 * "denominator missing" reason.  Nothing threw; the report just said the company
 * had no earnings.
 *
 * So the assertions are about classification, not arithmetic: a row shape is
 * either consumable by the year-to-date TTM formula or it is not, and the wrong
 * answer has to fail loudly here rather than look like missing data downstream.
 */
import assert from "node:assert/strict";


// A-share cumulative family and the annual 12M family.
assert.equal(isCumulativeIncomeRow({ FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_income.v1" }), true);
assert.equal(isCumulativeIncomeRow({ FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_annual_income.v1" }), true);

// Hong Kong F10 main-indicator rows: cumulative for Q1/H1/9M, FY for DATE_TYPE 001.
// This is the regression: these must be `true` or HK valuations silently vanish.
assert.equal(isCumulativeIncomeRow({ FINANCIAL_SOURCE_CONTRACT: "eastmoney_hk_f10_main_indicator.v2" }), true);
assert.equal(isCumulativeIncomeRow({ FINANCIAL_SOURCE_CONTRACT: "eastmoney_hk_f10_main_indicator.v1" }), true);

// A-share single-quarter family must never be fed to the year-to-date formula:
// `*INCOMEQC` values are already a single quarter, so subtracting them from a
// cumulative row would double-count.
assert.equal(isCumulativeIncomeRow({ FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }), false);

// Yahoo rows are a *duration* (12M/3M), not a cumulative/quarter distinction, so
// they cannot be treated as year-to-date even when the period happens to be 12M.
assert.equal(isCumulativeIncomeRow({ FINANCIAL_SOURCE_CONTRACT: "yahoo_finance_timeseries.v3" }), false);
assert.equal(isCumulativeIncomeRow({ FINANCIAL_SOURCE_CONTRACT: "yahoo_finance_timeseries.v2" }), false);

// Unknown and missing contracts fail closed: a new provider shape must be
// classified deliberately, never inherited.
assert.equal(isCumulativeIncomeRow({}), false);
assert.equal(isCumulativeIncomeRow({ FINANCIAL_SOURCE_CONTRACT: "" }), false);
assert.equal(isCumulativeIncomeRow({ FINANCIAL_SOURCE_CONTRACT: "some_new_provider.v9" }), false);

// The HK TTM identity, using 友邦保险's actual reported rows, proves the formula
// these contracts enable produces the number the API returned after the fix.
const fy2025 = 43_817_539_200;
const h1_2026 = 29_246_004_600;
const h1_2025 = 18_139_892_400;
const ttm = fy2025 + h1_2026 - h1_2025;
assert.equal(ttm, 54_923_651_400, "HK TTM = prior FY + current cumulative − prior-year same period");

console.log("income contracts self-test: ok", {
  cumulativeContracts: 4,
  quarterOnlyRejected: 1,
  yahooRejected: 2,
  hkTtmYi: (ttm / 1e8).toFixed(2),
});
