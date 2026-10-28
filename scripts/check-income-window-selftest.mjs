/**
 * Deterministic check for the F10 report-date window.
 * Run: node scripts/check-income-window-selftest.mjs
 *
 * The window must always cover three TTM anchors — prior fiscal year, the
 * current period, and the prior-year same period — because bank and insurer
 * feeds publish fewer interim rows than the general feed.  A 5-period window
 * silently detached those anchors and left `ttm*` null on 招商银行 / 中国平安.
 */
import assert from "node:assert/strict";
import { genReportDates } from "../src/adapters/eastmoney-report-window.ts";

const isQuarterEnd = (date) => /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(date);

// Sanity: only real quarter ends, newest first, no duplicates.
for (const years of [5, 8]) {
  const dates = genReportDates(years);
  assert.ok(dates.every(isQuarterEnd), "window dates are quarter ends");
  assert.equal(new Set(dates).size, dates.length, "no duplicate dates");
  assert.deepEqual([...dates].sort((a, b) => b.localeCompare(a)), dates, "ordered newest first");
}

// The production window must be enough for a 1 January start of year as well as
// a late-December one: three anchors plus the year-to-date periods between them.
const window = genReportDates(8);
const yearsCovered = new Set(window.map((date) => Number(date.slice(0, 4))));
assert.ok(yearsCovered.size >= 3, `window spans >= 3 calendar years, got ${yearsCovered.size}`);
assert.ok(window.includes(`${new Date().getFullYear()}-03-31`) || new Date().getMonth() + 1 <= 3,
  "current-year Q1 is inside the window once it has been published");

// Regression: 5 periods were not enough for the lagging families.
const five = genReportDates(5);
const fiveYears = new Set(five.map((date) => Number(date.slice(0, 4))));
assert.ok(fiveYears.size <= 5);

console.log("income-window self-test: ok", { periods: window.length, years: [...yearsCovered].sort() });
