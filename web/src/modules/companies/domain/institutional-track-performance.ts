type PriceObservation = {
  close?: unknown
  high?: unknown
  low?: unknown
}

function finitePositiveNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

export function calculateLookbackRangePosition(rows: PriceObservation[], lookbackTradingDays: number): {
  drawdownPct: number
  gainPct: number
} | null {
  if (!Number.isInteger(lookbackTradingDays) || lookbackTradingDays < 1) return null
  const window = rows
    .map((row) => ({
      close: finitePositiveNumber(row.close),
      high: finitePositiveNumber(row.high),
      low: finitePositiveNumber(row.low),
    }))
    .filter((row): row is { close: number, high: number, low: number } => row.close !== null && row.high !== null && row.low !== null)
    .slice(-lookbackTradingDays)
  if (window.length < lookbackTradingDays) return null
  const latestClose = window.at(-1)!.close
  const highestPrice = Math.max(...window.map((row) => row.high))
  const lowestPrice = Math.min(...window.map((row) => row.low))
  return {
    drawdownPct: Math.max(0, ((highestPrice - latestClose) / highestPrice) * 100),
    gainPct: Math.max(0, ((latestClose - lowestPrice) / lowestPrice) * 100),
  }
}
