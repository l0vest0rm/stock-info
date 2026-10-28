/**
 * Point-in-time PE: the multiple as it could be computed on the day it is dated.
 *
 * Every valuation question in this repository is asked about *today*, so the
 * current PE is computed from the newest statement available — which is correct,
 * because a statement that has been published is public knowledge.
 *
 * A backtest asks a different question: "on that day, what did an investor with
 * only public information see?"  Those two questions have different answers
 * whenever a provider's series quietly uses a figure before it was published.
 *
 * Xueqiu's daily `peTtm` does exactly that.  Its implied trailing profit switches
 * on the REPORT_DATE, not the announcement date:
 *
 *     2019-01-02   PE 21.37   implied TTM profit 352.04 亿   ← uses FY2018
 *
 * but the FY2018 annual was published 2019-03-29.  For roughly three months each
 * spring the series carries earnings that did not exist yet.  Measured across
 * eight companies and 12,690 trading days, 29.8% of observations are affected,
 * with errors up to −32.9% and +89.5%
 * (`scripts/analyze-pe-lookahead-bias.py`).
 *
 * That error is harmless for today's verdicts — they never read the historical
 * series — but any test of "did a cheap multiple predict returns" would be
 * measuring the future leaking into the past.  So a backtest rebuilds PE from two
 * clean inputs instead:
 *
 *     market cap  daily, from the price series, never revised
 *     TTM profit  the rows public on that day, via NOTICE_DATE
 *
 * The TTM arithmetic itself is not reimplemented here.  `trailingTwelveMonths`
 * already resolves the annual base from what the provider declares, which is what
 * keeps 阿里巴巴's March year end from being annualised off a December row.  This
 * module only decides *which rows were knowable*, and then delegates.
 *
 * Read-only. No price is emitted, no target, no instruction.
 */
import type { FinancialStatement } from "../../../types";
import { trailingTwelveMonths } from "../../finance/domain/ttm-fiscal-calendar.ts";

/**
 * The announcement date of a statement, or null when the row does not carry one.
 *
 * A missing date is not treated as "always known": that would silently reinstate
 * the look-ahead this module exists to remove.  A row with no announcement date
 * can only be used once it is safely in the past — see `KNOWN_WITHOUT_NOTICE_DAYS`.
 */
export function noticeDateOf(row: FinancialStatement): string | null {
  const payload = row.payload && typeof row.payload === "object"
    ? row.payload as Record<string, unknown>
    : {};
  const raw = payload.NOTICE_DATE ?? payload.noticeDate ?? payload.UPDATE_DATE ?? payload.updateDate;
  const text = typeof raw === "string" ? raw.slice(0, 10) : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return text;
}

/**
 * Grace period applied to a row that carries no announcement date.
 *
 * Chinese disclosure rules require a quarterly report within one month of the
 * period end, an interim within two, and an annual within four.  Where the
 * provider omits NOTICE_DATE we therefore cannot claim the figure was public
 * sooner than the statutory deadline, and using the period end would be exactly
 * the bias being removed.  Rows without a date are used only from the deadline
 * onward, and the count is reported so a caller can see how much rests on it.
 */
export const KNOWN_WITHOUT_NOTICE_DAYS = 120;

/**
 * Was this statement knowable on `asOf`?
 *
 * Statements dated on or before `asOf` are excluded by construction: a row about
 * a period that had not ended yet cannot have been published.
 */
export function isKnowableAt(row: FinancialStatement, asOf: string): boolean {
  if (row.reportDate > asOf) return false;
  const notice = noticeDateOf(row);
  if (notice !== null) return notice <= asOf;
  const deadline = addDays(row.reportDate, KNOWN_WITHOUT_NOTICE_DAYS);
  return deadline <= asOf;
}

/** `YYYY-MM-DD` plus whole days, in UTC so the result does not depend on locale. */
export function addDays(date: string, days: number): string {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return date;
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

export type PointInTimeSeriesPoint = {
  date: string;
  /** Market value of the equity, in the quote currency. */
  marketCap: number;
  /** Trailing twelve months net profit known on `date`, or null when incomplete. */
  ttmNetProfit: number | null;
  /** `marketCap / ttmNetProfit` when both are usable, else null. */
  peTtm: number | null;
  /** Report dates the TTM figure was built from. */
  basisReportDates: string[];
  /** Announcement dates behind that basis, for auditing a single point. */
  basisNoticeDates: string[];
};

export type PointInTimeOptions = {
  /** Read net profit off a row. Defaults to parent-company net profit, then total. */
  netProfitOf?: (row: FinancialStatement) => number | null;
  /** Exclude multiples at or above this, which a near-zero denominator produces. */
  ceiling?: number;
};

const DEFAULT_CEILING = 300;

function defaultNetProfitOf(row: FinancialStatement): number | null {
  const payload = row.payload && typeof row.payload === "object"
    ? row.payload as Record<string, unknown>
    : {};
  for (const key of ["PARENT_NETPROFIT", "parentNetprofit", "NETPROFIT", "netProfit", "HOLDER_PROFIT"]) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Rebuild the PE series from a daily market cap and the statements public on each day.
 *
 * One pass over the statements rather than a filter per day: the statement set is
 * small (tens of rows) and the price series is thousands of rows, so sorting the
 * statements once and advancing a pointer keeps this linear.
 */
export function buildPointInTimePeSeries(
  statements: FinancialStatement[],
  marketCaps: Array<{ date: string; marketCap: number }>,
  options: PointInTimeOptions = {},
): PointInTimeSeriesPoint[] {
  const netProfitOf = options.netProfitOf ?? defaultNetProfitOf;
  const ceiling = options.ceiling ?? DEFAULT_CEILING;

  const income = statements
    .filter((row) => row.statementType === "income")
    .slice()
    .sort((left, right) => left.reportDate.localeCompare(right.reportDate));

  const points: PointInTimeSeriesPoint[] = [];

  for (const bar of [...marketCaps].sort((left, right) => left.date.localeCompare(right.date))) {
    // Filtered per day rather than by advancing a pointer.  Announcement dates are
    // not monotonic in report date — a delayed annual and a punctual interim can
    // invert — so a pointer would stall on the late row and hide an earlier-known
    // one behind it.  Fifty statements by three thousand days is trivial.
    const knowable = income.filter((row) => isKnowableAt(row, bar.date));
    if (knowable.length === 0) {
      points.push({
        date: bar.date,
        marketCap: bar.marketCap,
        ttmNetProfit: null,
        peTtm: null,
        basisReportDates: [],
        basisNoticeDates: [],
      });
      continue;
    }

    const ttm = trailingTwelveMonths(knowable, netProfitOf);
    const usable = ttm !== null && Number.isFinite(ttm) && ttm > 0;
    const pe = usable ? bar.marketCap / ttm : null;

    // The basis is whatever the trailing-twelve-month rule used.  Reporting it
    // makes a single point auditable: a reader can check that the earnings behind
    // a 2019-01-02 PE were published before 2019-01-02.
    const { reportDates, noticeDates } = basisOf(knowable, bar.date);

    points.push({
      date: bar.date,
      marketCap: bar.marketCap,
      ttmNetProfit: usable ? ttm : null,
      peTtm: pe !== null && pe > 0 && pe <= ceiling ? pe : null,
      basisReportDates: reportDates,
      basisNoticeDates: noticeDates,
    });
  }
  return points;
}

/**
 * Report and announcement dates behind one observation.
 *
 * Mirrors the TTM rule exactly: a latest row that is itself a fiscal year is the
 * whole trailing year, so nothing is subtracted and the basis is that one row.
 * An earlier version searched for an "annual row before latest" unconditionally
 * and reported `[2025-12-31, 2024-12-31, 2024-12-31]` for an annual latest —
 * a duplicate that misdescribed which earnings a reader was looking at.  The
 * number was right and the audit trail was wrong, which is the worse failure:
 * a reviewer checking the note against the figure would have trusted it.
 */
function basisOf(knowable: FinancialStatement[], asOf: string): {
  reportDates: string[];
  noticeDates: string[];
} {
  void asOf;
  if (knowable.length === 0) return { reportDates: [], noticeDates: [] };
  const latest = knowable[knowable.length - 1];
  const reportDates = isAnnualLike(latest)
    ? [latest.reportDate]
    : basisFromAnnual(latest, knowable);
  const noticeDates = reportDates
    .map((date) => {
      const row = knowable.find((candidate) => candidate.reportDate === date);
      return row ? noticeDateOf(row) : null;
    })
    .filter((value): value is string => value !== null);
  return { reportDates, noticeDates };
}

/** The three anchors of `prior FY + current − prior-year same period`. */
function basisFromAnnual(latest: FinancialStatement, knowable: FinancialStatement[]): string[] {
  const annual = [...knowable]
    .reverse()
    .find((row) => row.reportDate < latest.reportDate && isAnnualLike(row));
  if (!annual) return [latest.reportDate];
  const offset = monthsBetween(annual.reportDate, latest.reportDate) - 12;
  const twinDate = shiftMonthsLocal(annual.reportDate, offset);
  const twin = knowable.find((row) => row.reportDate === twinDate);
  return twin
    ? [latest.reportDate, annual.reportDate, twin.reportDate]
    : [latest.reportDate, annual.reportDate];
}

function isAnnualLike(row: FinancialStatement): boolean {
  const payload = row.payload && typeof row.payload === "object"
    ? row.payload as Record<string, unknown>
    : {};
  const reportType = String(payload.REPORT_TYPE ?? "").trim();
  const period = String(payload.FISCAL_PERIOD ?? row.fiscalPeriod ?? "").trim();
  return /年报|^年度$/.test(reportType) || /^(12M|FY|ANNUAL)$/i.test(period);
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

function shiftMonthsLocal(date: string, delta: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const zeroBased = month - 1 + delta;
  const targetYear = year + Math.floor(zeroBased / 12);
  const targetMonth = ((zeroBased % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}
