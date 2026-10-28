/**
 * Deterministic check that trailing-twelve-month PE keeps a source-declared
 * annual row that shares its fiscal-year-end date with a quarterized Q4 row.
 * Run: node scripts/check-ttm-annual-base-selftest.mjs
 *
 * The production selector lives in an application module whose cache imports
 * need the runtime bundler, so this check reproduces the documented TTM rule
 * (annual base + current cumulative − prior-year same period) over the same
 * row contract and asserts the Q4 row is never used as the annual base.
 */
import assert from "node:assert/strict";

const ANNUAL_CONTRACT = "eastmoney_f10_annual_income.v1";
const isAnnual = (row) => row.payload.FINANCIAL_SOURCE_CONTRACT === ANNUAL_CONTRACT;

const row = (reportDate, payload) => ({ code: "TEST", statementType: "income", reportDate, fiscalPeriod: payload.FISCAL_PERIOD ?? null, payload });

/** Selection rule under test: annual observations survive a same-date Q4 row. */
export function selectDatedRows(rows) {
  const byDate = new Map();
  const annual = new Map();
  for (const item of rows) {
    if (item.statementType === "income" && isAnnual(item)) {
      annual.set(item.reportDate, item);
      continue;
    }
    if (!byDate.has(item.reportDate)) byDate.set(item.reportDate, item);
  }
  const merged = new Map(byDate);
  for (const [date, item] of annual) merged.set(date, item);
  return [...merged.values()];
}

function ttmNetProfit(rows) {
  const dated = selectDatedRows(rows).sort((left, right) => right.reportDate.localeCompare(left.reportDate));
  const latest = dated[0];
  const [year, month, day] = latest.reportDate.split("-").map(Number);
  if (isAnnual(latest) || (month === 12 && day === 31)) return latest.payload.PARENT_NETPROFIT;
  const previousAnnual = dated.find((item) => item.reportDate === `${year - 1}-12-31` && isAnnual(item));
  // The prior-year comparison period is a mid-year cumulative row.  A
  // 12-31 comparison would be a Q4 quarter or an annual statement, neither of
  // which is the same period as the latest interim row.
  if (month === 12) return null;
  const monthDay = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const priorPeriod = dated.find((item) => item.reportDate === `${year - 1}-${monthDay}`);
  if (!previousAnnual || !priorPeriod) return null;
  return previousAnnual.payload.PARENT_NETPROFIT + latest.payload.PARENT_NETPROFIT - priorPeriod.payload.PARENT_NETPROFIT;
}

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
assert.equal(selectDatedRows(rows).find((item) => item.reportDate === "2025-12-31").payload.PARENT_NETPROFIT, 10.80);

// Without the annual row the result must degrade to null instead of using Q4 as FY.
assert.equal(ttmNetProfit(rows.filter((item) => !isAnnual(item))), null);

console.log("ttm-annual-base self-test: ok", { ttmNetProfit: ttmNetProfit(rows) });
