type IncomeReportForPeTtm = {
  FISCAL_PERIOD?: unknown
  FINANCIAL_SOURCE_CONTRACT?: unknown
  REPORT_TYPE?: unknown
  fiscalPeriod?: unknown
  noticeDate?: unknown
  parentNetprofit?: unknown
  reportDate?: unknown
}

type QuarterlyProfit = {
  profit: number
  reportMonth: number
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(`${value.slice(0, 10)}T00:00:00Z`)
  return Number.isFinite(parsed) ? parsed : null
}

function isAnnualReport(row: IncomeReportForPeTtm): boolean {
  const period = String(row.FISCAL_PERIOD ?? row.fiscalPeriod ?? '').trim().toUpperCase()
  const reportType = String(row.REPORT_TYPE ?? '').trim().toUpperCase()
  return period === '12M' || reportType === '年报' || reportType === 'ANNUAL' || reportType === 'FY'
}

/**
 * Is this row a single quarter's own value, rather than a year-to-date cumulative?
 *
 * The two families are separate Eastmoney reports and must not be mixed:
 * `*_incomeqc.v1` holds one quarter (一季度/二季度/三季度/四季度), while
 * `*_income.v1` holds 年初至今累计 (一季报/中报/三季报/年报).  Treating a
 * cumulative row as a quarter is not a small error — 2025年年报 2248 亿 was
 * being added to three cumulative interims for 腾讯, and H1 was added as if it
 * were Q2 for 茅台, producing PE 6.23 and 10.86 against true 14.93 and 20.58.
 */
export function isSingleQuarter(row: IncomeReportForPeTtm): boolean {
  const contract = String(row.FINANCIAL_SOURCE_CONTRACT ?? '').trim().toLowerCase()
  if (contract.endsWith('incomeqc.v1')) return true
  if (contract.endsWith('income.v1') || contract.endsWith('annual_income.v1')) return false
  // Legacy rows without a contract marker: accept only unambiguous quarter
  // labels ("二季度"), never the cumulative ones ("中报", "三季报").
  const reportType = String(row.REPORT_TYPE ?? '').trim()
  return /^[一二三四]季度$/.test(reportType)
}

function fourConsecutiveQuarters(profits: QuarterlyProfit[]): boolean {
  return profits.every((item, index) => index === 0 || item.reportMonth === profits[index - 1].reportMonth - 3)
}

/**
 * Returns the four disclosed, consecutive single-quarter parent profits used
 * by PE(TTM).
 *
 * Only genuinely single-quarter rows qualify.  When a market publishes no
 * single-quarter family at all — Hong Kong's `RPT_HKF10_FN_MAININDICATOR`
 * returns cumulative only — this returns `[]` so the caller shows 暂无数据
 * instead of adding cumulative figures into a number that looks like a PE.
 * Deriving quarters by subtracting cumulative rows is deliberately not done
 * here: that conversion belongs on the server, which already owns the fiscal
 * calendar (`domain/ttm-fiscal-calendar.ts`).
 */
export function trailingQuarterlyParentNetProfits(
  rows: IncomeReportForPeTtm[],
  asOfTimestamp = Number.POSITIVE_INFINITY,
): number[] {
  const byReportMonth = new Map<number, QuarterlyProfit>()
  for (const row of rows) {
    if (isAnnualReport(row)) continue
    if (!isSingleQuarter(row)) continue
    const reportTimestamp = timestamp(row.reportDate)
    const availableTimestamp = timestamp(row.noticeDate) ?? reportTimestamp
    const profit = Number(row.parentNetprofit)
    if (reportTimestamp === null || availableTimestamp === null || availableTimestamp > asOfTimestamp || !Number.isFinite(profit)) continue

    const reportDate = new Date(reportTimestamp)
    const reportMonth = reportDate.getUTCFullYear() * 12 + reportDate.getUTCMonth()
    if (!byReportMonth.has(reportMonth)) {
      byReportMonth.set(reportMonth, { profit, reportMonth })
    }
  }

  const profits = [...byReportMonth.values()]
    .sort((left, right) => right.reportMonth - left.reportMonth)
    .slice(0, 4)
  return profits.length === 4 && fourConsecutiveQuarters(profits)
    ? profits.map((item) => item.profit)
    : []
}
