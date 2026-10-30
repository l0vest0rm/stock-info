// Retained assertion coverage; all domain computations execute in native Rust.
import { callRustSelftest } from './lib/rust-analysis.mjs';
const buildQuarterlySeries = (...args) => callRustSelftest('buildQuarterlySeries', ...args);
const incomeFamilyOf = (...args) => callRustSelftest('incomeFamilyOf', ...args);
const previousQuarterEnd = (...args) => callRustSelftest('previousQuarterEnd', ...args);
/**
 * Deterministic check for the quarterly series assembly.
 * Run: node scripts/check-quarterly-series-selftest.mjs
 *
 * Fixtures mirror the two Eastmoney income families the adapter now retains:
 * `*INCOME` (year-to-date: 一季报/中报/三季报/年报) and `*INCOMEQC` (the quarter
 * alone: 一季度/二季度/三季度/四季度).  A 12-31 date therefore legitimately
 * carries three observations — cumulative 年报, cumulative interim, and Q4.
 */
import assert from "node:assert/strict";


const YI = 100_000_000;

const row = (reportDate, payload, family) => ({
  code: "TEST",
  statementType: "income",
  reportDate,
  fiscalPeriod: payload.REPORT_TYPE ?? null,
  payload: {
    dataSource: "financial_report",
    FINANCIAL_SOURCE_CONTRACT: family === "cumulative" ? "eastmoney_f10_income.v1" : "eastmoney_f10_incomeqc.v1",
    ...payload,
  },
  source: "eastmoney",
  rawR2Key: null,
  updatedAt: 1_700_000_000_000,
});

const cumulative = (date, revenue, profit, label) =>
  row(date, { TOTAL_OPERATE_INCOME: revenue * YI, PARENT_NETPROFIT: profit * YI, REPORT_TYPE: label }, "cumulative");
const quarter = (date, revenue, profit, label) =>
  row(date, { TOTAL_OPERATE_INCOME: revenue * YI, PARENT_NETPROFIT: profit * YI, REPORT_TYPE: label }, "quarterized");
const annual = (date, revenue, profit) => ({
  ...row(date, { TOTAL_OPERATE_INCOME: revenue * YI, PARENT_NETPROFIT: profit * YI, REPORT_TYPE: "年报" }, "cumulative"),
  fiscalPeriod: "12M",
  payload: {
    dataSource: "financial_report",
    FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_annual_income.v1",
    TOTAL_OPERATE_INCOME: revenue * YI,
    PARENT_NETPROFIT: profit * YI,
    REPORT_TYPE: "年报",
    FISCAL_PERIOD: "12M",
  },
});

// Calendar helper sanity.
assert.equal(previousQuarterEnd("2026-06-30"), "2026-03-31");
assert.equal(previousQuarterEnd("2026-09-30"), "2026-06-30");
assert.equal(previousQuarterEnd("2026-12-31"), "2026-09-30");
assert.equal(previousQuarterEnd("2026-03-31"), "2025-12-31");
assert.equal(previousQuarterEnd("2026-05-31"), null);

// Family tagging: the two contracts must not be conflated.
assert.equal(incomeFamilyOf(annual("2025-12-31", 60, 20)), "cumulative");
assert.equal(incomeFamilyOf(cumulative("2025-06-30", 24, 8, "中报")), "cumulative");
assert.equal(incomeFamilyOf(quarter("2025-06-30", 14, 4, "二季度")), "quarterized");

// ---------------------------------------------------------------- fixture
// 2025 quarters (single quarter): Q1 10, Q2 14, Q3 15, Q4 21 → FY 60
// 2025 cumulative: Q1 10, H1 24, 9M 39, FY 60
// 2026 cumulative: Q1 15, H1 40   /  2026 quarters: Q1 15, Q2 25
const rows = [
  cumulative("2026-06-30", 40, 12, "中报"),
  quarter("2026-06-30", 25, 7, "二季度"),
  cumulative("2026-03-31", 15, 5, "一季报"),
  quarter("2026-03-31", 15, 5, "一季度"),
  quarter("2025-12-31", 21, 7, "四季度"),
  annual("2025-12-31", 60, 20),
  cumulative("2025-09-30", 39, 13, "三季报"),
  quarter("2025-09-30", 15, 5, "三季度"),
  cumulative("2025-06-30", 24, 8, "中报"),
  quarter("2025-06-30", 14, 4, "二季度"),
  cumulative("2025-03-31", 10, 3, "一季报"),
  quarter("2025-03-31", 10, 3, "一季度"),
  quarter("2024-12-31", 18, 6, "四季度"),
  annual("2024-12-31", 52, 18),
  cumulative("2024-09-30", 34, 12, "三季报"),
  quarter("2024-09-30", 13, 6, "三季度"),
  cumulative("2024-06-30", 21, 7, "中报"),
  quarter("2024-06-30", 14, 4, "二季度"),
  cumulative("2024-03-31", 8, 2, "一季报"),
  quarter("2024-03-31", 8, 2, "一季度"),
];

const series = buildQuarterlySeries("TEST", rows, { limit: 8 });
const point = (date) => series.points.find((item) => item.reportDate === date);
const near = (actual, expected, label) =>
  assert.ok(
    actual !== null && Math.abs(actual / YI - expected) < 1e-9,
    `${label}: expected ${expected} 亿, got ${actual === null ? "null" : actual / YI}`,
  );

assert.deepEqual(series.families, { cumulative: true, quarterized: true });

// Every point keeps both readings side by side — no subtraction, no guessing.
near(point("2026-06-30").cumulativeRevenue, 40, "H1 2026 cumulative revenue");
near(point("2026-06-30").quarterRevenue, 25, "Q2 2026 single-quarter revenue");
near(point("2026-03-31").cumulativeRevenue, 15, "Q1 2026 cumulative revenue");
near(point("2026-03-31").quarterRevenue, 15, "Q1 2026 single-quarter revenue");

// Q4 and FY coexist on the same date and must not overwrite each other.
near(point("2025-12-31").quarterRevenue, 21, "Q4 2025 single quarter");
near(point("2025-12-31").cumulativeRevenue, 60, "FY 2025 cumulative");

// TTM is the cumulative identity, not a sum of quarters.
near(point("2025-12-31").ttmRevenue, 60, "TTM 2025 = FY report");
assert.equal(point("2025-12-31").ttmBasis, "annual");
near(point("2026-06-30").ttmRevenue, 60 + 40 - 24, "TTM 2026H1 = FY25 + H1 26 − H1 25");
near(point("2026-06-30").ttmNetProfit, 20 + 12 - 8, "TTM 2026H1 net profit");
assert.equal(point("2026-06-30").ttmBasis, "cumulative_roll");

// YoY is on single quarters.
assert.ok(Math.abs(point("2026-06-30").revenueYoY - (25 / 14 - 1)) < 1e-9, "Q2 2026 revenue YoY");
assert.ok(Math.abs(point("2025-12-31").netProfitYoY - (7 / 6 - 1)) < 1e-9, "Q4 2025 net profit YoY");
// YoY is resolved from the full history, not the trimmed window.
const narrow = buildQuarterlySeries("TEST", rows, { limit: 2 });
assert.equal(narrow.points.find((item) => item.reportDate === "2026-06-30").revenueYoY, point("2026-06-30").revenueYoY);

// ------------------------------------------------------------- degradations
// Cumulative family missing (e.g. a CUS-family issuer) ⇒ no TTM, but the
// quarterized values still stand.
const quarterOnly = buildQuarterlySeries("TEST", rows.filter((item) => incomeFamilyOf(item) === "quarterized"), { limit: 8 });
assert.deepEqual(quarterOnly.families, { cumulative: false, quarterized: true });
assert.equal(quarterOnly.points.every((item) => item.ttmRevenue === null), true, "TTM needs the cumulative family");
near(quarterOnly.points.find((item) => item.reportDate === "2026-06-30").quarterRevenue, 25, "quarter stays available");
assert.ok(quarterOnly.limitations.some((text) => text.includes("*INCOME）")), "limitation names the missing family");

// Quarterized family missing ⇒ cumulative + TTM still work, per-quarter is null.
const cumulativeOnly = buildQuarterlySeries("TEST", rows.filter((item) => incomeFamilyOf(item) === "cumulative"), { limit: 8 });
assert.equal(cumulativeOnly.points.every((item) => item.quarterRevenue === null), true);
near(cumulativeOnly.points.find((item) => item.reportDate === "2026-06-30").ttmRevenue, 76, "TTM still computed");
assert.ok(cumulativeOnly.points.find((item) => item.reportDate === "2026-06-30").gaps.includes("quarterRevenue"));

// Missing annual ⇒ TTM null, and the Q4 quarter is never promoted to FY.
const noAnnual = rows.filter((item) => item.payload.FINANCIAL_SOURCE_CONTRACT !== "eastmoney_f10_annual_income.v1");
const degraded = buildQuarterlySeries("TEST", noAnnual, { limit: 8 });
const degradedH1 = degraded.points.find((item) => item.reportDate === "2026-06-30");
assert.equal(degradedH1.ttmRevenue, null, "Q4 must not stand in for a missing annual statement");
assert.equal(degraded.complete, false);
near(degraded.points.find((item) => item.reportDate === "2025-12-31").quarterRevenue, 21, "Q4 row still readable");

// Non-quarter-end rows are skipped instead of misaligned.
const noisy = [...rows, cumulative("2026-05-31", 99, 99, "五月")];
assert.equal(buildQuarterlySeries("TEST", noisy, { limit: 40 }).points.some((item) => item.reportDate === "2026-05-31"), false);

// A performance flash must not outrank the formal report on the same date.
// Formal rows carry no provenance; only pre-disclosure estimates do.
const flash = {
  ...cumulative("2026-06-30", 41, 13, "中报"),
  payload: { ...cumulative("2026-06-30", 41, 13, "中报").payload, dataSource: "performance_report" },
};
const flashSeries = buildQuarterlySeries("TEST", [flash, ...rows], { limit: 8 });
near(flashSeries.points.find((item) => item.reportDate === "2026-06-30").cumulativeRevenue, 40, "formal report wins");

console.log("quarterly-series self-test: ok", {
  latest: series.latestReportDate,
  points: series.points.length,
  complete: series.complete,
  families: series.families,
});
