import { isSingleQuarter } from './pe-ttm.ts'

/** The raw API retains both income families for other consumers (including TTM).
 * The finance page sums quarters for yearly mode, so it must select a single
 * family BEFORE charting, comparing or summing. Never fill a missing quarter
 * with a cumulative row. Preserve cumulative-only markets' existing cadence.
 */
export function financeDisplayIncomeRows<T extends { reportDate?: unknown; noticeDate?: unknown }>(rows: T[]): T[] {
  const quarters = rows.filter(isSingleQuarter)
  const selected = quarters.length ? quarters : rows
  const byDate = new Map<string, T>()
  for (const row of selected) {
    const date = String(row.reportDate ?? '')
    if (!date) continue
    const previous = byDate.get(date)
    if (!previous || String(row.noticeDate ?? '') > String(previous.noticeDate ?? '')) {
      byDate.set(date, row)
    }
  }
  return [...byDate.values()].sort((left, right) => String(right.reportDate).localeCompare(String(left.reportDate)))
}
