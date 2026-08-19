export type LatestKlinePrice = {
  price: number
  date: string
  source: 'close'
}

type KlineLike = {
  date?: unknown
  close?: unknown
}

function positiveNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * Strategy underlyings use the stock K-line boundary. A valid response must
 * carry a trade close; a fund-NAV payload means the server routed the code to
 * the wrong market-data source and must not be silently treated as a price.
 */
export function latestKlinePrice(rows: unknown): LatestKlinePrice | null {
  if (!Array.isArray(rows)) return null
  for (const rawRow of [...rows].reverse()) {
    if (!rawRow || typeof rawRow !== 'object') continue
    const row = rawRow as KlineLike
    const price = positiveNumber(row.close)
    if (price !== null) return { price, date: typeof row.date === 'string' ? row.date : '', source: 'close' }
  }
  return null
}
