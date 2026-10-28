/**
 * Deterministic check for the browser-side PE(TTM) quarter selection.
 * Run: node scripts/check-web-pe-ttm-selftest.mjs
 *
 * The company page draws a PE(TTM) line from `/api/finance/income`, which
 * returns two families side by side:
 *
 *   *INCOME    → 年初至今累计 (一季报 / 中报 / 三季报 / 年报)
 *   *INCOMEQC  → 该季度单独值 (一季度 / 二季度 / 三季度 / 四季度)
 *
 * Adding "the last four rows" therefore added a full-year profit as if it were
 * a single quarter.  Both numbers were plausible, which is exactly why this
 * needs a test rather than a code review: 腾讯 rendered 6.23 against a true
 * 14.93, and 茅台 10.86 against 20.58.
 *
 * The fix is a refusal: only genuine single-quarter rows are summed, and a
 * market that publishes cumulative only returns nothing at all rather than a
 * number that looks like a PE.
 */
import assert from "node:assert/strict";
import { trailingQuarterlyParentNetProfits } from "../web/src/modules/company/domain/pe-ttm.ts";

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    throw err;
  }
};

const row = (reportDate, parentNetprofit, extra = {}) => ({
  reportDate,
  parentNetprofit,
  ...extra,
});

// --- the bug this file exists for -------------------------------------------

check("cumulative rows are never summed as quarters", () => {
  // 茅台's real payload: H1 cumulative 445.17 亿, Q1 272.43 亿, FY 823.20 亿,
  // Q4-quarter 176.93 亿.  Feeding only cumulative rows must yield nothing.
  const cumulativeOnly = [
    row("2026-06-30", 44_516_880_421.86, { REPORT_TYPE: "中报", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_income.v1" }),
    row("2026-03-31", 27_242_512_886.45, { REPORT_TYPE: "一季报", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_income.v1" }),
    row("2025-12-31", 82_320_067_101.68, { REPORT_TYPE: "年报", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_annual_income.v1" }),
    row("2025-09-30", 64_626_746_712.18, { REPORT_TYPE: "三季报", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_income.v1" }),
  ];
  assert.deepEqual(trailingQuarterlyParentNetProfits(cumulativeOnly), []);
});

check("single-quarter family is summed, newest first", () => {
  const quarters = [
    row("2026-06-30", 17_274_367_535.41, { REPORT_TYPE: "二季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }),
    row("2026-03-31", 27_242_512_886.45, { REPORT_TYPE: "一季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }),
    row("2025-12-31", 17_693_320_389.5, { REPORT_TYPE: "四季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }),
    row("2025-09-30", 19_223_784_414.08, { REPORT_TYPE: "三季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }),
  ];
  const profits = trailingQuarterlyParentNetProfits(quarters);
  assert.equal(profits.length, 4);
  assert.equal(profits[0], 17_274_367_535.41);
});

check("mixed payloads keep only the single-quarter rows", () => {
  const mixed = [
    row("2026-06-30", 44_516_880_421.86, { REPORT_TYPE: "中报", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_income.v1" }),
    row("2026-06-30", 17_274_367_535.41, { REPORT_TYPE: "二季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }),
    row("2026-03-31", 27_242_512_886.45, { REPORT_TYPE: "一季报", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_income.v1" }),
    row("2026-03-31", 27_242_512_886.45, { REPORT_TYPE: "一季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }),
    row("2025-12-31", 82_320_067_101.68, { REPORT_TYPE: "年报", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_annual_income.v1" }),
    row("2025-12-31", 17_693_320_389.5, { REPORT_TYPE: "四季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }),
    row("2025-09-30", 19_223_784_414.08, { REPORT_TYPE: "三季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }),
  ];
  const profits = trailingQuarterlyParentNetProfits(mixed);
  assert.equal(profits.length, 4);
  // The 445.17 亿 cumulative H1 row must not appear.
  assert.ok(!profits.includes(44_516_880_421.86));
  const sum = profits.reduce((a, b) => a + b, 0);
  // 单季合计 ≈ 814.3 亿, vs the wrong 1540 亿 the old code produced.
  assert.ok(sum > 80e9 && sum < 82e9, `sum was ${(sum / 1e8).toFixed(1)} 亿`);
});

// --- refusal paths ----------------------------------------------------------

check("HK cumulative-only payload yields nothing instead of a fake PE", () => {
  // Tencent's real payload: main-indicator rows are all cumulative, tagged with
  // DATE_TYPE_CODE only.  Summing them produced PE 6.23 vs the true 14.93.
  const hk = [
    row("2026-06-30", 114_115_000_000, { REPORT_TYPE: "2026年中报", DATE_TYPE_CODE: "002" }),
    row("2026-03-31", 58_093_000_000, { REPORT_TYPE: "2026年一季报", DATE_TYPE_CODE: "003" }),
    row("2025-12-31", 224_842_000_000, { REPORT_TYPE: "2025年年报", DATE_TYPE_CODE: "001" }),
    row("2025-09-30", 166_582_000_000, { REPORT_TYPE: "2025年三季报", DATE_TYPE_CODE: "004" }),
  ];
  assert.deepEqual(trailingQuarterlyParentNetProfits(hk), []);
});

check("annual rows are excluded even when marked as a quarter", () => {
  const tricky = [
    row("2025-12-31", 100, { REPORT_TYPE: "四季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }),
    row("2025-12-31", 400, { FISCAL_PERIOD: "12M" }),
    row("2025-09-30", 100, { REPORT_TYPE: "三季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }),
    row("2025-06-30", 100, { REPORT_TYPE: "二季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }),
    row("2025-03-31", 100, { REPORT_TYPE: "一季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }),
  ];
  const profits = trailingQuarterlyParentNetProfits(tricky);
  assert.equal(profits.length, 4);
  assert.ok(!profits.includes(400));
});

check("three non-consecutive quarters are refused", () => {
  const gapped = [
    row("2026-06-30", 100, { REPORT_TYPE: "二季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }),
    row("2026-03-31", 100, { REPORT_TYPE: "一季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }),
    row("2025-09-30", 100, { REPORT_TYPE: "三季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }),
    row("2025-06-30", 100, { REPORT_TYPE: "二季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" }),
  ];
  assert.deepEqual(trailingQuarterlyParentNetProfits(gapped), []);
});

check("asOfDateTime still excludes not-yet-published quarters", () => {
  const quarters = [
    row("2026-06-30", 100, { REPORT_TYPE: "二季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1", noticeDate: "2026-08-20" }),
    row("2026-03-31", 100, { REPORT_TYPE: "一季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1", noticeDate: "2026-04-25" }),
    row("2025-12-31", 100, { REPORT_TYPE: "四季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1", noticeDate: "2026-03-20" }),
    row("2025-09-30", 100, { REPORT_TYPE: "三季度", FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1", noticeDate: "2025-10-25" }),
  ];
  const asOfMid2026 = Date.parse("2026-05-01T00:00:00Z");
  // Only Q1 2026 is visible by 2026-05-01, so the four-quarter window is not
  // complete and the value must be refused rather than computed on stale rows.
  assert.deepEqual(trailingQuarterlyParentNetProfits(quarters, asOfMid2026), []);
});

console.log(`web PE(TTM) quarter selection: ${passed} checks passed`);
