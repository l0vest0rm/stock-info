import type { FinancialStatement } from "../../../types";
import { isFormalAnnualIncomeStatement } from "./annual-income-statements.ts";

/**
 * Trailing twelve months across fiscal calendars that do not end in December.
 *
 * The TTM identity is `prior FY + current cumulative − prior-year same period`.
 * It has exactly one free parameter — which row counts as "prior FY" — and this
 * module resolves it from what the provider *declares*, never from the date.
 *
 * Assuming a 12-31 year end was wrong twice, silently:
 *
 * - 阿里巴巴 reports a March year end. Its latest row is the June quarter, so
 *   the old date-based lookup searched for `2025-12-31`, found a *Q3* row, and
 *   subtracted that from the fiscal-year total. TTM net profit came out at
 *   480 亿 instead of 736 亿 — a 35% understatement, and the band still said
 *   `available` because a number is a number;
 * - 友邦保险 and 农夫山泉 file only annual and interim reports, so there is no
 *   Q3 row to mis-find and the two shapes must still agree on the base row.
 *
 * A date cannot express a fiscal calendar, so a December end is never used as
 * evidence of a fiscal year here either. The provider already says which row is
 * the year: `DATE_TYPE_CODE=001` for Hong Kong, the `*INCOME` annual family for
 * A-shares, `FISCAL_PERIOD`/`REPORT_TYPE` for cash-flow and Yahoo rows.
 */

/**
 * Is this row a full fiscal year, for a statement of any type?
 *
 * `isFormalAnnualIncomeStatement` is typed for income rows and requires that
 * contract family. Cash-flow rows carry none of it — an A-share cash-flow row
 * has no contract and no `FISCAL_PERIOD` at all, and marks the year only as
 * `REPORT_TYPE=年报` — so capex needs the wider check below. Both branches read
 * a provider declaration and neither invents a fourth signal.
 */
export function isFiscalYearRow(row: FinancialStatement): boolean {
  if (row.statementType === "income") return isFormalAnnualIncomeStatement(row);
  const payload = payloadOf(row);
  const contract = String(payload.FINANCIAL_SOURCE_CONTRACT ?? "");
  if (contract.startsWith("eastmoney_hk_f10_main_indicator.")) {
    return String(payload.DATE_TYPE_CODE ?? "") === "001";
  }
  const period = String(payload.FISCAL_PERIOD ?? row.fiscalPeriod ?? "").trim();
  if (/^(12M|FY|ANNUAL|年报|年度)$/i.test(period)) return true;
  return /年报|年度|^FY\b/i.test(String(payload.REPORT_TYPE ?? "").trim());
}

/**
 * The annual row a TTM calculation subtracts from.
 *
 * Constrained to rows strictly before the period being annualised: a company
 * whose latest row *is* a fiscal year must not subtract from that same year.
 * Returns null rather than falling back, because a wrong base produces a
 * plausible-looking number and a missing one does not.
 */
export function annualBaseFor(
  rows: FinancialStatement[],
  beforeDate: string,
): FinancialStatement | null {
  let best: FinancialStatement | null = null;
  for (const row of rows) {
    if (row.reportDate >= beforeDate) continue;
    if (!isFiscalYearRow(row)) continue;
    if (!best || row.reportDate > best.reportDate) best = row;
  }
  return best;
}

/**
 * Prior-year same period, on the same fiscal calendar.
 *
 * Matched by month offset from the annual base rather than by `year − 1` on the
 * calendar date. For a March year end, the June quarter's prior-year twin sits
 * in a different calendar year than subtracting one from its own year suggests,
 * and `2026-06-30 → 2025-06-30` happens to be right only by coincidence.
 */
export function priorSamePeriodFor(
  rows: FinancialStatement[],
  latest: FinancialStatement,
  annual: FinancialStatement,
): FinancialStatement | null {
  const offsetMonths = monthsBetween(annual.reportDate, latest.reportDate);
  const target = shiftMonths(annual.reportDate, offsetMonths - 12);
  const candidates = rows.filter((row) => row.reportDate === target);
  if (candidates.length === 0) return null;
  // The period being annualised is not a fiscal year, so the comparison period
  // must have the same duration.  A fiscal-year end date can carry both an
  // annual row and a quarter row; taking the annual one would turn the identity
  // into `FY + Q − FY` and silently return a single quarter.
  return candidates.find((row) => !isFiscalYearRow(row)) ?? candidates[0];
}

/**
 * TTM for one metric, given how to read that metric off a row.
 *
 * `valueOf` returning null means the field is absent for that period, which
 * must fail the whole calculation: `annual + current − 0` would overstate.
 */
export function trailingTwelveMonths(
  rows: FinancialStatement[],
  valueOf: (row: FinancialStatement) => number | null,
): number | null {
  const sorted = [...rows].sort((left, right) =>
    right.reportDate.localeCompare(left.reportDate)
    // A fiscal-year end carries two observations — the annual statement and the
    // Q4 quarter.  The annual one must win the tie: taking Q4 as "latest" would
    // annualise a single quarter.
    || Number(isFiscalYearRow(right)) - Number(isFiscalYearRow(left)));
  const latest = sorted[0];
  if (!latest) return null;

  // A row that is itself a fiscal year already covers twelve months.
  if (isFiscalYearRow(latest)) return valueOf(latest);

  const annual = annualBaseFor(sorted, latest.reportDate);
  if (!annual) return null;
  const priorSame = priorSamePeriodFor(sorted, latest, annual);
  if (!priorSame) return null;

  const [annualValue, current, priorValue] = [valueOf(annual), valueOf(latest), valueOf(priorSame)];
  if (annualValue === null || current === null || priorValue === null) return null;
  return annualValue + current - priorValue;
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/** Shift a `YYYY-MM-DD` date by whole months, clamping to the month's last day. */
export function shiftMonths(date: string, delta: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const zeroBased = month - 1 + delta;
  const targetYear = year + Math.floor(zeroBased / 12);
  const targetMonth = ((zeroBased % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

function payloadOf(row: FinancialStatement): Record<string, unknown> {
  return row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
}
