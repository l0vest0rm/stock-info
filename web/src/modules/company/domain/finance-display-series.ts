type IncomeDisplayRow = {
  reportDate?: unknown
  REPORT_TYPE?: unknown
  FINANCIAL_SOURCE_CONTRACT?: unknown
  FISCAL_PERIOD?: unknown
  fiscalPeriod?: unknown
}

function isSingleQuarter(row: IncomeDisplayRow): boolean {
  const contract = String(row.FINANCIAL_SOURCE_CONTRACT ?? '').trim().toLowerCase()
  if (contract.endsWith('incomeqc.v1')) return true
  if (contract.endsWith('income.v1') || contract.endsWith('annual_income.v1')) return false
  if (contract.startsWith('eastmoney_hk_f10_main_indicator.')) return false
  if (contract.startsWith('yahoo_finance_timeseries.')) {
    return String(row.FISCAL_PERIOD ?? row.fiscalPeriod ?? '').trim().toUpperCase() === '3M'
  }
  return /^[一二三四]季度$/.test(String(row.REPORT_TYPE ?? '').trim())
}

/**
 * Display one consistent income family, then one row per date. Keep the raw
 * cache untouched: cumulative statements remain necessary for server-side TTM.
 * A cumulative-only market is not quarterized here. In yearly view keep its
 * latest disclosed cumulative period rather than adding overlapping interims.
 */
export function financeDisplayIncomeRows<T extends IncomeDisplayRow>(rows: readonly T[], yearly = false): T[] {
  const quarters = rows.filter(isSingleQuarter)
  const selected = quarters.length ? quarters : [...rows]
  const dates = new Set<string>()
  const years = new Set<string>()
  return selected
    .filter(row => typeof row.reportDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.reportDate))
    .sort((left, right) => String(right.reportDate).localeCompare(String(left.reportDate)))
    .filter(row => {
      const date = String(row.reportDate)
      if (dates.has(date)) return false
      dates.add(date)
      const year = date.slice(0, 4)
      if (yearly && !quarters.length && years.has(year)) return false
      years.add(year)
      return true
    })
}
