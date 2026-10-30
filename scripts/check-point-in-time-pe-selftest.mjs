// Retained assertion coverage; all domain computations execute in native Rust.
import { callRustSelftest, buildPointInTimePeSeries } from './lib/rust-analysis.mjs';
const nativeConstants = callRustSelftest('constants');
const KNOWN_WITHOUT_NOTICE_DAYS = nativeConstants.KNOWN_WITHOUT_NOTICE_DAYS;
const addDays = (...args) => callRustSelftest('addDays', ...args);
const isKnowableAt = (...args) => callRustSelftest('isKnowableAt', ...args);
const noticeDateOf = (...args) => callRustSelftest('noticeDateOf', ...args);
/**
 * Deterministic check for the point-in-time PE rebuild.
 * Run: node scripts/check-point-in-time-pe-selftest.mjs
 *
 * The rebuild exists to remove one specific defect: Xueqiu's historical `peTtm`
 * switches its denominator on the REPORT_DATE, so it carries earnings before they
 * were published.  寒武纪 is the clean demonstration — on 2026-03-31 its implied
 * trailing profit jumped from 20.592 亿 to 27.170 亿, but the 2026 Q1 report was
 * announced 2026-04-30, a full 30 days later.
 *
 * The assertions therefore pin the properties that make a backtest honest:
 *
 * 1. a row is used only once its announcement date has passed;
 * 2. a row whose announcement date is missing is given the statutory deadline,
 *    not the period end — otherwise the fix would reintroduce the bug;
 * 3. a row about a period that had not ended yet is never used;
 * 4. the TTM arithmetic is the shared one, so a March year end still annualises
 *    correctly;
 * 5. the audit trail names the rows actually used.
 */
import assert from "node:assert/strict";


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

const YI = 100_000_000;

/** One income row, with explicit announcement date. */
function row(reportDate, noticeDate, profitYi, reportType = "季报") {
  return {
    code: "TEST.SH",
    statementType: "income",
    reportDate,
    fiscalPeriod: reportType,
    payload: {
      REPORT_DATE: reportDate,
      REPORT_TYPE: reportType,
      NOTICE_DATE: noticeDate === null ? null : `${noticeDate} 00:00:00`,
      PARENT_NETPROFIT: profitYi * YI,
    },
    source: "eastmoney",
    rawR2Key: null,
    updatedAt: 0,
  };
}

// --- 1. announcement date, not report date, decides availability ------------

check("a row is not knowable before its announcement date", () => {
  const fy = row("2025-12-31", "2026-03-13", 20.592, "年报");
  assert.equal(isKnowableAt(fy, "2026-03-12"), false, "one day early");
  assert.equal(isKnowableAt(fy, "2026-03-13"), true, "on the announcement date");
  assert.equal(isKnowableAt(fy, "2026-05-01"), true, "after");
});

check("the 寒武纪 case: 2026 Q1 earnings before they were published", () => {
  // The live defect.  Xueqiu switched to 27.170 亿 on 2026-03-31; the report was
  // announced 2026-04-30.  A point-in-time series must still say 20.592 亿 on
  // 2026-03-31 and only switch on 2026-04-30.
  const statements = [
    row("2024-12-31", "2025-04-19", 10.0, "年报"),
    row("2025-03-31", "2025-04-30", 3.0, "一季报"),
    row("2025-12-31", "2026-03-13", 20.592, "年报"),
    row("2026-03-31", "2026-04-30", 10.132, "一季报"),
  ];
  const caps = [
    { date: "2026-03-30", marketCap: 4256.7 * YI },
    { date: "2026-03-31", marketCap: 4145.2 * YI },
    { date: "2026-04-30", marketCap: 4145.2 * YI },
  ];
  const series = buildPointInTimePeSeries(statements, caps);
  const before = series.find((p) => p.date === "2026-03-31");
  assert.equal(before.ttmNetProfit, 20.592 * YI, "still last year's annual");
  assert.deepEqual(before.basisReportDates, ["2025-12-31"]);
  assert.deepEqual(before.basisNoticeDates, ["2026-03-13"]);

  const after = series.find((p) => p.date === "2026-04-30");
  // FY2025 (20.592) + Q1 2026 (10.132) − Q1 2025 (3.0) = 27.724
  assert.equal(Math.round(after.ttmNetProfit / YI * 100) / 100, 27.72);
  assert.deepEqual(after.basisReportDates, ["2026-03-31", "2025-12-31", "2025-03-31"]);
});

// --- 2. a missing announcement date must not become "always known" ----------

check("a row with no announcement date waits for the statutory deadline", () => {
  const undated = row("2025-12-31", null, 20.0, "年报");
  assert.equal(noticeDateOf(undated), null);
  assert.equal(isKnowableAt(undated, "2026-01-01"), false, "not the period end");
  assert.equal(isKnowableAt(undated, addDays("2025-12-31", KNOWN_WITHOUT_NOTICE_DAYS - 1)), false);
  assert.equal(isKnowableAt(undated, addDays("2025-12-31", KNOWN_WITHOUT_NOTICE_DAYS)), true);
});

check("UPDATE_DATE is accepted as a fallback announcement date", () => {
  const revised = row("2025-12-31", null, 20.0, "年报");
  revised.payload.UPDATE_DATE = "2026-03-20 00:00:00";
  assert.equal(noticeDateOf(revised), "2026-03-20");
  assert.equal(isKnowableAt(revised, "2026-03-19"), false);
  assert.equal(isKnowableAt(revised, "2026-03-20"), true);
});

// --- 3. a period that had not ended cannot be known ------------------------

check("a row about a future period is never used", () => {
  const future = row("2026-06-30", "2026-08-15", 99.0, "中报");
  assert.equal(isKnowableAt(future, "2026-06-29"), false);
  assert.equal(isKnowableAt(future, "2026-08-15"), true);
  // Even a row that claims a suspiciously early announcement is rejected before
  // the period ends — that combination is a data defect, not a fast reporter.
  const impossible = row("2026-06-30", "2026-05-01", 99.0, "中报");
  assert.equal(isKnowableAt(impossible, "2026-06-01"), false);
});

// --- 4. the shared TTM rule still handles a non-December year end -----------

check("a March year end annualises off the declared fiscal year", () => {
  // 阿里巴巴 shape: FY ends 3-31.  Taking a 12-31 row as the annual base would
  // understate TTM, which is the defect ttm-fiscal-calendar exists to prevent.
  const statements = [
    row("2025-03-31", "2025-05-15", 100.0, "年报"),
    row("2025-06-30", "2025-08-15", 30.0, "中报"),
    row("2025-09-30", "2025-11-15", 55.0, "三季报"),
  ];
  const caps = [{ date: "2025-11-20", marketCap: 1000 * YI }];
  const series = buildPointInTimePeSeries(statements, caps);
  const point = series[0];
  // FY2025 (100) + 9M (55) − prior-year same period is absent, so the series must
  // report incomplete rather than silently subtract nothing.
  assert.equal(point.ttmNetProfit, null, "a missing prior-year anchor must not be papered over");
  assert.deepEqual(point.basisReportDates, ["2025-09-30", "2025-03-31"], "the audit trail names what it had");
});

// --- 5. unusable denominators are reported, not turned into multiples -------

check("a loss-making trailing year yields no PE, not a negative one", () => {
  const statements = [
    row("2024-12-31", "2025-04-01", -5.0, "年报"),
    row("2025-12-31", "2026-03-20", -2.0, "年报"),
  ];
  const series = buildPointInTimePeSeries(statements, [{ date: "2026-04-01", marketCap: 100 * YI }]);
  assert.equal(series[0].ttmNetProfit, null);
  assert.equal(series[0].peTtm, null, "a negative denominator is not a cheap multiple");
});

check("an implausible multiple is excluded at the ceiling", () => {
  const statements = [row("2025-12-31", "2026-03-20", 0.01, "年报")];
  const series = buildPointInTimePeSeries(
    statements,
    [{ date: "2026-04-01", marketCap: 100 * YI }],
    { ceiling: 300 },
  );
  assert.equal(series[0].ttmNetProfit, 0.01 * YI);
  assert.equal(series[0].peTtm, null, "10,000x is a data artefact, not an observation");
});

check("no knowable statement yields an empty point, not a fabricated one", () => {
  const statements = [row("2025-12-31", "2026-03-20", 20.0, "年报")];
  const series = buildPointInTimePeSeries(statements, [{ date: "2025-06-30", marketCap: 500 * YI }]);
  assert.equal(series[0].ttmNetProfit, null);
  assert.equal(series[0].peTtm, null);
  assert.deepEqual(series[0].basisReportDates, []);
});

// --- 6. ordering ------------------------------------------------------------

check("points follow the input dates in ascending order regardless of input order", () => {
  const statements = [row("2025-12-31", "2026-03-20", 20.0, "年报")];
  const series = buildPointInTimePeSeries(statements, [
    { date: "2026-05-01", marketCap: 400 * YI },
    { date: "2026-04-01", marketCap: 300 * YI },
    { date: "2026-06-01", marketCap: 500 * YI },
  ]);
  assert.deepEqual(series.map((p) => p.date), ["2026-04-01", "2026-05-01", "2026-06-01"]);
  assert.equal(series[0].peTtm, 15);
});

check("a delayed annual does not hide an earlier-known interim", () => {
  // Announcement dates are not monotonic in report date.  A pointer-based scan
  // would stall on the late annual and never see the punctual interim behind it.
  const statements = [
    row("2025-12-31", "2026-04-30", 20.0, "年报"),  // unusually late
    row("2025-06-30", "2025-08-15", 10.0, "中报"),
    row("2025-03-31", "2025-04-25", 4.0, "一季报"),
    row("2024-12-31", "2025-03-25", 8.0, "年报"),
    row("2024-06-30", "2024-08-20", 3.0, "中报"),
  ];
  const series = buildPointInTimePeSeries(statements, [{ date: "2025-09-01", marketCap: 200 * YI }]);
  // FY2024 (8) + H1 2025 (10) − H1 2024 (3) = 15, off the interim — not off the
  // 2025 annual, which nobody could have read in September.
  assert.equal(series[0].ttmNetProfit, 15.0 * YI);
  assert.deepEqual(series[0].basisReportDates, ["2025-06-30", "2024-12-31", "2024-06-30"]);
});

console.log(`point-in-time PE: ${passed} checks passed`);
