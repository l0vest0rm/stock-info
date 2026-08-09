type IncomeReportForPeTtm = {
  FISCAL_PERIOD?: unknown
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

function fourConsecutiveQuarters(profits: QuarterlyProfit[]): boolean {
  return profits.every((item, index) => index === 0 || item.reportMonth === profits[index - 1].reportMonth - 3)
}

/**
 * Returns the four disclosed, consecutive single-quarter parent profits used
 * by PE(TTM). Annual (12M) rows must not be added to the Q4 row for the same
 * reporting date.
 */
export function trailingQuarterlyParentNetProfits(
  rows: IncomeReportForPeTtm[],
  asOfTimestamp = Number.POSITIVE_INFINITY,
): number[] {
  const byReportMonth = new Map<number, QuarterlyProfit>()
  for (const row of rows) {
    if (isAnnualReport(row)) continue
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
