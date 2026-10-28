/** Normalize existing structured Eastmoney fields without inference or LLM calls.
 * Relative forecast years belong to the report's publication year, never today.
 */
export function normalizeForwardReference(item: Record<string, unknown>): Record<string, unknown> {
  const number = (value: unknown): number | undefined => {
    if (typeof value !== 'number' && typeof value !== 'string') return undefined;
    if (typeof value === 'string' && !value.trim()) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  };
  const year = Number(String(item.publishDate ?? '').match(/^(\d{4})[-/]/)?.[1]);
  const forecasts = new Map<number, Record<string, unknown>>();
  if (year >= 2000 && year <= 2100) {
    ['ThisYear', 'NextYear', 'NextTwoYear'].forEach((suffix, offset) => {
      const eps = number(item[`predict${suffix}Eps`]);
      const pe = number(item[`predict${suffix}Pe`]);
      const netProfit = number(item[`predict${suffix}Profit`]);
      if (eps !== undefined || pe !== undefined || netProfit !== undefined) forecasts.set(year + offset, {
        year: year + offset, ...(eps !== undefined ? { eps } : {}),
        ...(pe !== undefined && pe > 0 ? { pe } : {}), ...(netProfit !== undefined ? { netProfit } : {}),
      });
    });
  }
  for (const row of Array.isArray(item.forecasts) ? item.forecasts : []) {
    if (!row || typeof row !== 'object') continue;
    const y = number(row.year);
    if (!y || !Number.isInteger(y)) continue;
    const existing = forecasts.get(y) ?? { year: y };
    for (const key of ['eps', 'pe', 'netProfit', 'revenue', 'profitGrowth', 'revenueGrowth']) {
      const value = number(row[key]);
      if (value !== undefined) existing[key] = value;
    }
    forecasts.set(y, existing);
  }
  return { ...item, forecasts: [...forecasts.values()].sort((a, b) => Number(a.year) - Number(b.year)) };
}
