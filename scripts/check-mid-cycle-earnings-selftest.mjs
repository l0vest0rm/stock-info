// Retained assertion coverage; all domain computations execute in native Rust.
import { callRustSelftest } from './lib/rust-analysis.mjs';
const nativeConstants = callRustSelftest('constants');
const buildMidCycleEarnings = (...args) => callRustSelftest('buildMidCycleEarnings', ...args);
const MID_CYCLE_MIN_YEARS = nativeConstants.MID_CYCLE_MIN_YEARS;
/**
 * Deterministic check for mid-cycle earnings.
 * Run: node scripts/check-mid-cycle-earnings-selftest.mjs
 *
 * The invariants that matter: only annual rows, missing years never padded,
 * loss years kept, and no centre below the minimum sample.
 */
import assert from "node:assert/strict";


const YI = 100_000_000;
const annual = (year, parentNetProfit, extra = {}) => ({
  reportDate: `${year}-12-31`,
  isAnnual: true,
  parentNetProfit: parentNetProfit === null ? null : parentNetProfit * YI,
  netProfit: parentNetProfit === null ? null : parentNetProfit * YI,
  operatingProfit: parentNetProfit === null ? null : parentNetProfit * YI,
  investIncome: 0,
  fairValueChangeIncome: 0,
  ...extra,
});

// 1. A clean ten-year cyclical: centre is the mean/median of annuals.
const clean = buildMidCycleEarnings({
  rows: [10, 12, 14, 8, 6, 20, 30, 18, 16, 22].map((value, index) => annual(2025 - index, value)),
});
assert.equal(clean.status, "available");
assert.equal(clean.years.length, 10);
assert.equal(clean.window, "2016..2025");
assert.ok(Math.abs(clean.mean - 15.6 * YI) < 1, "mean is the arithmetic mean of annuals");
assert.ok(Math.abs(clean.median - 15 * YI) < 1, "median of ten values is the middle average");
assert.equal(clean.min, 6 * YI);
assert.equal(clean.max, 30 * YI);
assert.ok(Math.abs(clean.peakToCentre - 2) < 1e-9);

// 2. Interim rows are ignored, even when the provider marks them cumulative.
const withInterim = buildMidCycleEarnings({
  rows: [
    { reportDate: "2026-06-30", isAnnual: false, parentNetProfit: 999 * YI, netProfit: 999 * YI, operatingProfit: 999 * YI, investIncome: 0, fairValueChangeIncome: 0 },
    ...[10, 12, 14, 8, 6, 20].map((value, index) => annual(2025 - index, value)),
  ],
});
assert.equal(withInterim.years.length, 6, "the half-year row never enters the series");
assert.ok(withInterim.years.every((year) => year.fiscalYear <= 2025));

// 3. Missing years are reported, not interpolated, and do not reach the minimum.
const gappy = buildMidCycleEarnings({
  rows: [annual(2025, 10), annual(2023, 12), annual(2022, 14)],
});
assert.equal(gappy.status, "insufficient_data");
assert.deepEqual(gappy.missingYears, [2024, 2021, 2020, 2019, 2018, 2017, 2016], "absent years are listed, newest first");
assert.equal(gappy.years.length, 3);
assert.equal(gappy.mean, null, "no centre from a padded series");

// 4. Loss years stay in the sample; dropping them would overstate the centre.
const lossy = buildMidCycleEarnings({
  rows: [annual(2025, 30), annual(2024, -10), annual(2023, 12), annual(2022, 14), annual(2021, 8), annual(2020, 6)],
});
assert.deepEqual(lossy.lossYears, [2024]);
assert.equal(lossy.years.length, 6);
assert.ok(lossy.notes.some((text) => text.includes("亏损年度")), "loss years are disclosed");
assert.ok(Math.abs(lossy.mean - 10 * YI) < 1, "the loss year reduces the mean");

// 5. A single spike triggers the mean/median divergence note.
const spiky = buildMidCycleEarnings({
  rows: [annual(2025, 200), annual(2024, 10), annual(2023, 12), annual(2022, 14), annual(2021, 8), annual(2020, 6)],
});
assert.ok(spiky.notes.some((text) => text.includes("单一年份主导")), "spike is flagged");
assert.ok(spiky.notes.some((text) => text.includes("峰值是中枢的")));

// 6. The window is clamped to five..ten years.
const clamped = buildMidCycleEarnings({ rows: Array.from({ length: 20 }, (_, index) => annual(2025 - index, 10)), years: 25 });
assert.equal(clamped.years.length, 10, "window never exceeds ten years");
assert.equal(MID_CYCLE_MIN_YEARS, 5);

// 7. EBIT basis strips investment and fair-value income like valuation-inputs.
const ebitRows = Array.from({ length: 6 }, (_, index) => ({
  reportDate: `${2025 - index}-12-31`,
  isAnnual: true,
  parentNetProfit: 10 * YI,
  netProfit: 10 * YI,
  operatingProfit: 20 * YI,
  investIncome: 3 * YI,
  fairValueChangeIncome: 1 * YI,
}));
const ebitBased = buildMidCycleEarnings({ rows: ebitRows, basis: "ebit" });
assert.ok(Math.abs(ebitBased.median - 16 * YI) < 1, "EBIT proxy = operating profit − investment − fair value");

// 8. Always states the scope limit.
assert.ok(clean.notes.some((text) => text.includes("非周期公司")), "non-cyclical misuse is warned");

console.log("mid-cycle-earnings self-test: ok", {
  cleanMeanYi: clean.mean / YI,
  cleanMedianYi: clean.median / YI,
  spikyNotes: spiky.notes.length,
});
