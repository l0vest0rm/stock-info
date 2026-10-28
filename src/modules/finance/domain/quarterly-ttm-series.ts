/**
 * Quarterly series assembled from the two income families Eastmoney already
 * exposes, which is the project's existing extraction path — no new provider:
 *
 * - `GINCOME`   year-to-date cumulative (一季报 / 中报 / 三季报 / 年报)
 * - `GINCOMEQC` single quarter       (一季度 / 二季度 / 三季度 / 四季度)
 *
 * Reading a single family and guessing its convention from residuals is what
 * made an earlier version of this module call a single-quarter row
 * "cumulative".  The two families answer different questions, so the series
 * carries both explicitly instead of trying to infer one from the other:
 *
 * - `cumulative*`: what the issuer reports for the year so far
 * - `quarter*`   : what the issuer reports for that quarter alone
 *
 * TTM is `prior FY cumulative + current cumulative − prior-year same cumulative`,
 * which is only defined on the cumulative family.
 */
import type { FinancialStatement } from "../../../types";
import { isCumulativeIncomeRow } from "./income-row-contracts.ts";
import { isFiscalYearRow, trailingTwelveMonths } from "./ttm-fiscal-calendar.ts";

export type QuarterlyTtmPoint = {
  /** Quarter end that the trailing period ends on. */
  reportDate: string;
  /** Source label of the cumulative row, e.g. 中报. */
  fiscalPeriod: string | null;
  /** Year-to-date value from the cumulative family (`*INCOME`). */
  cumulativeRevenue: number | null;
  cumulativeNetProfit: number | null;
  /** Single-quarter value from the quarterized family (`*INCOMEQC`). */
  quarterRevenue: number | null;
  quarterNetProfit: number | null;
  /** Trailing twelve months; defined on the cumulative family only. */
  ttmRevenue: number | null;
  ttmNetProfit: number | null;
  /**
   * How the TTM value was obtained:
   * - `annual`: the point is a fiscal year end, so TTM is that year's report.
   * - `cumulative_roll`: prior FY + current cumulative − prior-year same period.
   */
  ttmBasis: "annual" | "cumulative_roll" | null;
  /** Single-quarter YoY; null when the same quarter a year earlier is missing. */
  revenueYoY: number | null;
  netProfitYoY: number | null;
  /** True when any value on this point came from a pre-disclosure estimate. */
  provisional: boolean;
  /** Fields that could not be produced for this point. */
  gaps: string[];
};

export type QuarterlySeriesReadModel = {
  code: string;
  basis: "eastmoney_income_cumulative_plus_quarterized";
  source: "financial_statements";
  /**
   * Which source families actually contributed rows.  A CUS-family issuer
   * (bank / insurer / broker) reports through a different table, so its
   * quarterized rows may be absent while the cumulative rows are present.
   */
  families: { cumulative: boolean; quarterized: boolean };
  latestReportDate: string | null;
  points: QuarterlyTtmPoint[];
  /** True when every returned point carries a usable TTM value. */
  complete: boolean;
  limitations: string[];
};

const GAP_LABELS: Record<string, string> = {
  cumulativeRevenue: "累计营收",
  cumulativeNetProfit: "累计净利",
  quarterRevenue: "单季营收",
  quarterNetProfit: "单季净利",
  ttmRevenue: "TTM 营收",
  ttmNetProfit: "TTM 净利",
  revenueYoY: "营收同比",
  netProfitYoY: "净利同比",
};

export function buildQuarterlySeries(
  code: string,
  rows: FinancialStatement[],
  options: { limit?: number } = {},
): QuarterlySeriesReadModel {
  const incomeRows = rows.filter((row) => row.statementType === "income");
  const cumulativeByDate = new Map<string, FinancialStatement>();
  const quarterByDate = new Map<string, FinancialStatement>();
  let hasCumulative = false;
  let hasQuarterized = false;

  for (const row of incomeRows) {
    const family = incomeFamilyOf(row);
    if (!family) continue;
    const target = family === "cumulative" ? cumulativeByDate : quarterByDate;
    if (family === "cumulative") hasCumulative = true;
    else hasQuarterized = true;
    // Formal reports outrank a same-date performance flash/forecast row.
    const existing = target.get(row.reportDate);
    if (!existing || (isProvisional(existing) && !isProvisional(row))) target.set(row.reportDate, row);
  }

  // A fiscal year end carries two cumulative readings (the interim table's
  // 年报 row and the annual statement family).  Both are full-year values.
  const dates = [...new Set([...cumulativeByDate.keys(), ...quarterByDate.keys()])]
    .sort()
    .reverse()
    .filter((date) => isQuarterEnd(date));

  const points: QuarterlyTtmPoint[] = [];
  for (const reportDate of dates) {
    const cumulativeRow = cumulativeByDate.get(reportDate) ?? null;
    const quarterRow = quarterByDate.get(reportDate) ?? null;
    const gaps: string[] = [];

    const cumulativeRevenue = cumulativeRow ? revenueOf(payloadOf(cumulativeRow)) : null;
    const cumulativeNetProfit = cumulativeRow ? profitOf(payloadOf(cumulativeRow)) : null;
    const quarterRevenue = quarterRow ? revenueOf(payloadOf(quarterRow)) : null;
    const quarterNetProfit = quarterRow ? profitOf(payloadOf(quarterRow)) : null;

    if (cumulativeRevenue === null) gaps.push("cumulativeRevenue");
    if (cumulativeNetProfit === null) gaps.push("cumulativeNetProfit");
    if (quarterRevenue === null) gaps.push("quarterRevenue");
    if (quarterNetProfit === null) gaps.push("quarterNetProfit");

    const ttm = ttmAt(cumulativeByDate, reportDate);
    if (ttm.revenue === null) gaps.push("ttmRevenue");
    if (ttm.netProfit === null) gaps.push("ttmNetProfit");

    points.push({
      reportDate,
      fiscalPeriod: (cumulativeRow ?? quarterRow)?.fiscalPeriod ?? null,
      cumulativeRevenue,
      cumulativeNetProfit,
      quarterRevenue,
      quarterNetProfit,
      ttmRevenue: ttm.revenue,
      ttmNetProfit: ttm.netProfit,
      ttmBasis: ttm.basis,
      revenueYoY: null,
      netProfitYoY: null,
      provisional: isProvisional(cumulativeRow ?? quarterRow),
      gaps,
    });
  }

  // YoY needs the same quarter a year earlier, so it is resolved over the full
  // history before trimming; otherwise narrowing `limit` would silently null it.
  const byDate = new Map(points.map((point) => [point.reportDate, point]));
  for (const point of points) {
    const prior = byDate.get(previousYearDate(point.reportDate));
    point.revenueYoY = ratioChange(point.quarterRevenue, prior?.quarterRevenue ?? null);
    point.netProfitYoY = ratioChange(point.quarterNetProfit, prior?.quarterNetProfit ?? null);
    if (point.revenueYoY === null) point.gaps.push("revenueYoY");
    if (point.netProfitYoY === null) point.gaps.push("netProfitYoY");
  }

  const limit = Math.min(Math.max(1, options.limit ?? 8), 40);
  const trimmed = points.slice(0, limit);
  const trimmedGaps = new Set(trimmed.flatMap((point) => point.gaps));
  const limitations: string[] = [
    "单季度直接取东财 *INCOMEQC 家族（一季度/二季度/三季度/四季度），当年累计取 *INCOME 家族（一季报/中报/三季报/年报），不做累计相减推算。",
    "TTM 只在累计口径上有定义：上年报 + 本期累计 − 上年同期累计；年报缺失的时点返回 null，不用四季度冒充全年。",
    "同比基于单季口径；上年同季缺失时返回 null，不做内插。",
  ];
  if (!hasCumulative) {
    limitations.push("本次没有取到累计家族行（*INCOME），该股票无法给出 TTM。");
  }
  if (!hasQuarterized) {
    limitations.push("本次没有取到单季度家族行（*INCOMEQC），该股票无法给出单季值、同比与反推 DCF 所需的季度形状。");
  }
  limitations.push(
    trimmedGaps.size > 0
      ? `返回区间内缺失字段：${[...trimmedGaps].map((gap) => GAP_LABELS[gap] ?? gap).join("、")}`
      : "返回区间内无缺失字段。",
  );

  return {
    code,
    basis: "eastmoney_income_cumulative_plus_quarterized",
    source: "financial_statements",
    families: { cumulative: hasCumulative, quarterized: hasQuarterized },
    latestReportDate: trimmed[0]?.reportDate ?? null,
    points: trimmed,
    complete: trimmed.length >= 4
      && trimmed.every((point) => point.ttmRevenue !== null && point.ttmNetProfit !== null),
    limitations,
  };
}

/**
 * Which Eastmoney income family a row came from.
 *
 * The adapter tags cumulative rows with `FINANCIAL_SOURCE_CONTRACT`
 * (`eastmoney_f10_income.v1`) and annual statements with
 * `eastmoney_f10_annual_income.v1`; quarterized rows carry neither and are
 * identified by the CPS contract when present.  Rows from non-Eastmoney
 * providers (Yahoo) are treated as cumulative only when their period label
 * says so, and are left out of the quarterized family entirely.
 *
 * Hong Kong F10 rows (`eastmoney_hk_f10_main_indicator.*`) are cumulative for
 * Q1/H1/9M and full-year for `DATE_TYPE_CODE=001`, but they carry no A-share
 * contract tag.  The fallthrough below classified them as *quarterized*, so
 * every HK company reported `families.cumulative=false`, all cumulative fields
 * null, and its cumulative interim value in the single-quarter column — a
 * 一季报 value presented as one quarter's profit.  The contract set is owned by
 * `income-row-contracts.ts`, which is the same list the TTM bands consume, so
 * ask it rather than repeating the A-share-only test here.
 */
export function incomeFamilyOf(row: FinancialStatement): "cumulative" | "quarterized" | null {
  const payload = payloadOf(row);
  const contract = typeof payload.FINANCIAL_SOURCE_CONTRACT === "string" ? payload.FINANCIAL_SOURCE_CONTRACT : "";
  if (contract === "eastmoney_f10_incomeqc.v1") return "quarterized";
  if (isCumulativeIncomeRow(payload)) return "cumulative";
  if (row.source !== "eastmoney") {
    return isAnnualLabel(row.fiscalPeriod ?? payload.FISCAL_PERIOD ?? payload.REPORT_TYPE)
      || isCumulativeLabel(row.fiscalPeriod ?? payload.FISCAL_PERIOD ?? payload.REPORT_TYPE)
      ? "cumulative"
      : null;
  }
  // Legacy snapshots written before the contract tag existed: the adapter only
  // ever fetched the quarterized family without the tag, so absence of a
  // contract means quarterized.
  return "quarterized";
}

function ttmAt(
  cumulativeByDate: Map<string, FinancialStatement>,
  reportDate: string,
): { revenue: number | null; netProfit: number | null; basis: "annual" | "cumulative_roll" | null } {
  const current = cumulativeByDate.get(reportDate);
  if (!current) return { revenue: null, netProfit: null, basis: null };
  const currentRevenue = revenueOf(payloadOf(current));
  const currentProfit = profitOf(payloadOf(current));

  // The fiscal year is whatever the provider declares, not whichever row lands
  // on 12-31: 阿里巴巴's March year end made the old date lookup treat a Q3 row
  // as the annual base. `ttm-fiscal-calendar.ts` owns that rule so the series
  // and the valuation bands cannot drift apart.
  //
  // Only rows up to this point may contribute — the function annualises the
  // latest row of what it is given, and a series point must not borrow a later
  // filing to compute an earlier TTM.
  const rows = [...cumulativeByDate.values()].filter((row) => row.reportDate <= reportDate);
  const basis = isFiscalYearRow(current) ? "annual" : "cumulative_roll";
  const revenue = trailingTwelveMonths(rows, (row) => revenueOf(payloadOf(row)));
  const netProfit = trailingTwelveMonths(rows, (row) => profitOf(payloadOf(row)));
  if (revenue === null && netProfit === null) {
    return { revenue: null, netProfit: null, basis: null };
  }
  return { revenue, netProfit, basis };
}

/** Previous calendar quarter end, or null when the date is not a quarter end. */
export function previousQuarterEnd(reportDate: string): string | null {
  const match = reportDate.match(/^(\d{4})-(03-31|06-30|09-30|12-31)$/);
  if (!match) return null;
  const year = Number(match[1]);
  switch (match[2]) {
    case "03-31": return `${year - 1}-12-31`;
    case "06-30": return `${year}-03-31`;
    case "09-30": return `${year}-06-30`;
    default: return `${year}-09-30`;
  }
}

function isQuarterEnd(reportDate: string): boolean {
  return /^\d{4}-(03-31|06-30|09-30|12-31)$/.test(reportDate);
}

function previousYearDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${Number(year) - 1}-${month}-${day}`;
}

function ratioChange(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null || prior === 0) return null;
  return current / prior - 1;
}

function isAnnualLabel(value: unknown): boolean {
  return /^(12M|FY|ANNUAL|年报)$/i.test(String(value ?? "").trim());
}

function isCumulativeLabel(value: unknown): boolean {
  return /^(中报|三季报|一季报|半年报|H1|9M|Q1|Q3)$/i.test(String(value ?? "").trim());
}

function isProvisional(row: FinancialStatement | null | undefined): boolean {
  if (!row) return false;
  const source = payloadOf(row).dataSource;
  return source === "performance_report" || source === "performance_forecast";
}

function revenueOf(payload: Record<string, unknown>): number | null {
  return numberValue(payload.TOTAL_OPERATE_INCOME) ?? numberValue(payload.OPERATE_INCOME);
}

function profitOf(payload: Record<string, unknown>): number | null {
  return numberValue(payload.PARENT_NETPROFIT) ?? numberValue(payload.NETPROFIT);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function payloadOf(row: FinancialStatement): Record<string, unknown> {
  const value = row.payload;
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
