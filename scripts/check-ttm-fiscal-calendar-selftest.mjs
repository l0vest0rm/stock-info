// Retained assertion coverage; all domain computations execute in native Rust.
import { callRustSelftest } from './lib/rust-analysis.mjs';
const annualBaseFor = (...args) => callRustSelftest('annualBaseFor', ...args);
const isFiscalYearRow = (...args) => callRustSelftest('isFiscalYearRow', ...args);
const priorSamePeriodFor = (...args) => callRustSelftest('priorSamePeriodFor', ...args);
const shiftMonths = (...args) => callRustSelftest('shiftMonths', ...args);
const trailingTwelveMonths = (...args) => callRustSelftest('trailingTwelveMonths', ...args);
const buildQuarterlySeries = (...args) => callRustSelftest('buildQuarterlySeries', ...args);
const incomeFamilyOf = (...args) => callRustSelftest('incomeFamilyOf', ...args);
/**
 * Fiscal-calendar check for trailing-twelve-month arithmetic.
 * Run: node scripts/check-ttm-fiscal-calendar-selftest.mjs
 *
 * The bug this exists to prevent is not arithmetic, it is an assumption: TTM is
 * `prior FY + current cumulative − prior-year same period`, and the old code
 * found "prior FY" by looking for a date ending in `12-31`.  That is correct
 * only for companies whose fiscal year happens to end in December.
 *
 * 阿里巴巴 reports a March year end. Its latest row was the June quarter, so
 * the old lookup found the previous `12-31` row — a *Q3* interim, not a fiscal
 * year — and subtracted it from the last annual total. TTM net profit came out
 * at 480 亿 instead of 736 亿, a 35% understatement, and nothing flagged it
 * because a wrong number and a right number are equally `available`.
 *
 * So these assertions are about which row is chosen, expressed as the number
 * the arithmetic produces: a March-year-end company must land on the 3-31
 * annual row, a December-year-end company on the 12-31 annual row, and a
 * company whose statement family carries no annual marker at all must return
 * null rather than promote an interim to fiscal year.
 */
import assert from "node:assert/strict";



const YI = 100_000_000;

/** An income row shaped the way the Hong Kong F10 adapter emits it. */
function hkIncome(reportDate, netProfitYi, dateTypeCode) {
  return {
    code: "09988.HK",
    statementType: "income",
    reportDate,
    fiscalPeriod: null,
    source: "eastmoney",
    rawR2Key: null,
    updatedAt: 0,
    payload: {
      FINANCIAL_SOURCE_CONTRACT: "eastmoney_hk_f10_main_indicator.v2",
      DATE_TYPE_CODE: dateTypeCode,
      // The adapter aliases `HOLDER_PROFIT` onto `PARENT_NETPROFIT`; both names
      // are present on a real row, so the fixture carries both.
      HOLDER_PROFIT: netProfitYi * YI,
      PARENT_NETPROFIT: netProfitYi * YI,
      // Revenue only has to exist for `complete` to be reachable; the
      // assertions below are all about the profit identity.
      TOTAL_OPERATE_INCOME: netProfitYi * 3 * YI,
    },
  };
}

/** A cash-flow row shaped the way the A-share adapter emits it. */
function cnCashflow(reportDate, capexYi) {
  return {
    code: "600036.SH",
    statementType: "cashflow",
    reportDate,
    fiscalPeriod: null,
    source: "eastmoney",
    rawR2Key: null,
    updatedAt: 0,
    // No contract, no FISCAL_PERIOD: A-share cash flow marks the year only in
    // REPORT_TYPE, which is why the income-only helper cannot serve capex.
    payload: { REPORT_TYPE: reportDate.endsWith("12-31") ? "年报" : "中报", CONSTRUCT_LONG_ASSET: capexYi * YI },
  };
}

const netProfitOf = (row) => {
  const value = row.payload.HOLDER_PROFIT;
  return typeof value === "number" ? value : null;
};

// --- 1. March year end: the regression ------------------------------------
//
// 阿里巴巴's real shape. The latest row is the June quarter of FY2027; the
// annual base is 2026-03-31. The 2025-12-31 row is a Q3 interim and must never
// be selected as a fiscal year.
const aliRows = [
  hkIncome("2026-06-30", 106.14, "003"),
  hkIncome("2026-03-31", 1035.92, "001"),
  hkIncome("2025-12-31", 780.51, "004"),
  hkIncome("2025-09-30", 616.68, "002"),
  hkIncome("2025-06-30", 406.49, "003"),
  hkIncome("2025-03-31", 1301.09, "001"),
  hkIncome("2024-12-31", 1175.50, "004"),
  hkIncome("2024-09-30", 684.23, "002"),
  hkIncome("2024-06-30", 243.90, "003"),
];

assert.equal(
  annualBaseFor(aliRows, "2026-06-30").reportDate,
  "2026-03-31",
  "the annual base must be the row the provider calls a fiscal year, not the previous 12-31",
);
assert.equal(
  priorSamePeriodFor(aliRows, aliRows[0], annualBaseFor(aliRows, "2026-06-30")).reportDate,
  "2025-06-30",
  "prior-year same period is the June quarter one year earlier",
);

// 1035.92 + 106.14 − 406.49 = 735.57 亿
const aliTtm = trailingTwelveMonths(aliRows, netProfitOf) / YI;
assert.ok(Math.abs(aliTtm - 735.57) < 0.01, `阿里巴巴 TTM must be 735.57 亿, got ${aliTtm.toFixed(2)}`);

// The old date-based lookup would have produced 780.51 + 106.14 − 406.49.
const wouldBeWrong = (780.51 + 106.14 - 406.49);
assert.ok(Math.abs(aliTtm - wouldBeWrong) > 1, "the corrected value must differ from the Q3-based one");

// --- 2. December year end must be unchanged --------------------------------
//
// 友邦保险 files only annual and interim reports. The fix must not move it.
const aiaRows = [
  hkIncome("2026-06-30", 292.46, "002"),
  hkIncome("2025-12-31", 438.18, "001"),
  hkIncome("2025-06-30", 181.40, "002"),
];
assert.equal(annualBaseFor(aiaRows, "2026-06-30").reportDate, "2025-12-31");
const aiaTtm = trailingTwelveMonths(aiaRows, netProfitOf) / YI;
assert.ok(Math.abs(aiaTtm - (438.18 + 292.46 - 181.40)) < 0.01, `友邦 TTM must stay 549.24 亿, got ${aiaTtm.toFixed(2)}`);

// --- 3. Latest row is already a fiscal year -------------------------------
//
// An annual row is twelve months on its own; it must not be annualised again by
// subtracting a prior year from itself.
const annualOnly = [hkIncome("2025-12-31", 438.18, "001")];
assert.equal(trailingTwelveMonths(annualOnly, netProfitOf) / YI, 438.18);

// --- 4. Cash-flow rows without an income-style contract --------------------
//
// A-share cash flow has neither FINANCIAL_SOURCE_CONTRACT nor FISCAL_PERIOD, so
// `isFormalAnnualIncomeStatement` is false for every row. Capex must still find
// the annual base through REPORT_TYPE, otherwise FCF silently goes missing for
// every A-share.
const cnCapex = [
  cnCashflow("2026-06-30", 227.44),
  cnCashflow("2025-12-31", 281.41),
  cnCashflow("2025-06-30", 72.01),
  cnCashflow("2024-12-31", 349.30),
];
assert.equal(isFiscalYearRow(cnCapex[1]), true, "REPORT_TYPE=年报 marks a fiscal year for cash flow");
assert.equal(isFiscalYearRow(cnCapex[0]), false);
const capexOf = (row) => row.payload.CONSTRUCT_LONG_ASSET / YI;
const cnTtm = trailingTwelveMonths(cnCapex, capexOf);
assert.ok(Math.abs(cnTtm - (281.41 + 227.44 - 72.01)) < 0.01, `A-share TTM capex got ${cnTtm.toFixed(2)}`);

// --- 5. A non-December fiscal year on cash flow ---------------------------
//
// Proves capex follows the fiscal calendar too, not just the income path.
const hkCapex = [
  { ...cnCashflow("2026-06-30", 30), payload: { FINANCIAL_SOURCE_CONTRACT: "eastmoney_hk_f10_main_indicator.v2", DATE_TYPE_CODE: "003", CONSTRUCT_LONG_ASSET: 30 * YI } },
  { ...cnCashflow("2026-03-31", 120), payload: { FINANCIAL_SOURCE_CONTRACT: "eastmoney_hk_f10_main_indicator.v2", DATE_TYPE_CODE: "001", CONSTRUCT_LONG_ASSET: 120 * YI } },
  { ...cnCashflow("2025-12-31", 95), payload: { FINANCIAL_SOURCE_CONTRACT: "eastmoney_hk_f10_main_indicator.v2", DATE_TYPE_CODE: "004", CONSTRUCT_LONG_ASSET: 95 * YI } },
  { ...cnCashflow("2025-06-30", 20), payload: { FINANCIAL_SOURCE_CONTRACT: "eastmoney_hk_f10_main_indicator.v2", DATE_TYPE_CODE: "003", CONSTRUCT_LONG_ASSET: 20 * YI } },
];
const hkCapexTtm = trailingTwelveMonths(hkCapex, capexOf);
assert.ok(Math.abs(hkCapexTtm - (120 + 30 - 20)) < 0.01, `March-year-end capex got ${hkCapexTtm.toFixed(2)}`);

// --- 6. Missing annual base degrades to null, never to an interim ---------
const noAnnual = [hkIncome("2026-06-30", 106.14, "003"), hkIncome("2025-12-31", 780.51, "004"), hkIncome("2025-06-30", 406.49, "003")];
assert.equal(trailingTwelveMonths(noAnnual, netProfitOf), null, "no fiscal-year row means no TTM, not a guessed one");

// --- 7. Date arithmetic ---------------------------------------------------
assert.equal(shiftMonths("2026-03-31", -12), "2025-03-31");
assert.equal(shiftMonths("2026-03-31", 3), "2026-06-30");
// Clamping: 2-29 shifted back a year lands on 2-28, not an invalid date.
assert.equal(shiftMonths("2024-02-29", -12), "2023-02-28");
assert.equal(shiftMonths("2026-01-31", 1), "2026-02-28");

// --- 8. Hong Kong family classification ----------------------------------
//
// HK rows are cumulative year-to-date, and `incomeFamilyOf` decides which
// column of the quarterly series they land in.  The old test listed only the
// two A-share contracts, so HK rows fell through to "quarterized": every HK
// company reported `families.cumulative = false`, its interim cumulative value
// appeared under 单季净利, and TTM was null throughout.
assert.equal(incomeFamilyOf(aliRows[0]), "cumulative", "HK 一季报 is cumulative, not a single quarter");
assert.equal(incomeFamilyOf(aliRows[1]), "cumulative", "HK 年报 is cumulative");
assert.equal(incomeFamilyOf(hkIncome("2026-06-30", 1, "004")), "cumulative", "HK 三季报 is cumulative");

// --- 9. Quarterly series over a March fiscal year ------------------------
const aliSeries = buildQuarterlySeries("09988.HK", aliRows, { limit: 40 });
assert.deepEqual(aliSeries.families, { cumulative: true, quarterized: false });
const aliH1 = aliSeries.points.find((point) => point.reportDate === "2026-06-30");
assert.ok(Math.abs(aliH1.ttmNetProfit / YI - 735.57) < 0.01, "series TTM must match the band denominator");
assert.equal(aliH1.quarterNetProfit, null, "HK has no single-quarter family; the cumulative value must not be relabelled");
assert.ok(Math.abs(aliH1.cumulativeNetProfit / YI - 106.14) < 0.01);

// The annual point is its own TTM, and an earlier point must not borrow a
// later filing to compute its trailing year.
const aliAnnualPoint = aliSeries.points.find((point) => point.reportDate === "2026-03-31");
assert.equal(aliAnnualPoint.ttmBasis, "annual");
assert.ok(Math.abs(aliAnnualPoint.ttmNetProfit / YI - 1035.92) < 0.01);
const aliQ3Point = aliSeries.points.find((point) => point.reportDate === "2025-12-31");
// 1301.09 (FY2025, 2025-03-31) + 780.51 (9M FY2026) − 1175.50 (9M FY2025)
assert.ok(Math.abs(aliQ3Point.ttmNetProfit / YI - (1301.09 + 780.51 - 1175.50)) < 0.01, `Q3 point TTM got ${(aliQ3Point.ttmNetProfit / YI).toFixed(2)}`);
// The earliest point has no prior-year twin, so it degrades to null instead of
// reaching for the annual row that happens to share its date.
const aliOldest = aliSeries.points.find((point) => point.reportDate === "2024-06-30");
assert.equal(aliOldest.ttmNetProfit, null, "no prior-year twin means no TTM");

console.log("ttm-fiscal-calendar self-test: ok", {
  "阿里巴巴": `${aliTtm.toFixed(2)} 亿`,
  "友邦": `${aiaTtm.toFixed(2)} 亿`,
  "A股capex": `${cnTtm.toFixed(2)} 亿`,
});
