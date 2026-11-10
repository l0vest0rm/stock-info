/**
 * Presentation-only helpers for the SSE option analysis page.
 *
 * All pricing (Black-Scholes, implied volatility, greeks, parity-implied
 * forward) is computed by the native Rust route `/api/options/cn/chain` and
 * arrives as already-finished numbers. Nothing here re-prices a contract;
 * these functions only sort, classify and format what the API returned so the
 * page can never disagree with the server about volatility.
 */

export type OptionChainContract = {
  contractId: string
  kind: 'C' | 'P'
  expiry: string | null
  expiryMonth: string
  strike: number
  /** Series adjusted for a corporate action: the code carries the old strike. */
  adjusted: boolean
  last: number
  previousSettlement: number
  changeRate: number | null
  timeToExpiry: number
  pricingBasis: 'forward' | 'spot'
  forward: number | null
  discountFactor: number | null
  volatility: number | null
  delta: number | null
  gamma: number | null
  thetaPerDay: number | null
  vegaPerPoint: number | null
  moneyness: number
  premiumShareOfSpot: number | null
  breakeven: number | null
  breakevenFromSpot: number | null
}

export type OptionChainResponse = {
  underlying: string
  asOf: string
  spot: number
  rate: number
  dividendYield: number
  source: string
  /** Trading date of the quotes, per the exchange snapshot. */
  quoteDate?: string | null
  contracts: OptionChainContract[]
}

export type OptionExpiration = {
  expiryMonth: string
  expiry: string | null
  daysToExpiry: number | null
  contracts: number
}

/**
 * Supported ETF option underlyings, in the order the page lists them.
 *
 * `market` decides the K-line symbol used for the spot price and tells the
 * reader which exchange publishes the board; the backend routes quotes per
 * exchange, so this field is descriptive, never a routing hint.
 */
export const OPTION_UNDERLYINGS = [
  { code: '510050', name: '上证50ETF', market: 'SH' },
  { code: '510300', name: '沪深300ETF', market: 'SH' },
  { code: '510500', name: '中证500ETF', market: 'SH' },
  { code: '588000', name: '科创50ETF', market: 'SH' },
  { code: '588080', name: '科创板50ETF', market: 'SH' },
  { code: '159915', name: '创业板ETF', market: 'SZ' },
  { code: '159919', name: '沪深300ETF(深)', market: 'SZ' },
  { code: '159922', name: '中证500ETF(深)', market: 'SZ' },
] as const

export type OptionUnderlying = (typeof OPTION_UNDERLYINGS)[number]

/**
 * Short-option risk brackets by absolute delta.
 *
 * These are descriptive labels for a selling decision, not recommendations:
 * they answer "how far out of the money is this premium" in risk terms that
 * survive changes in spot and volatility, which a raw strike percentage does
 * not. Boundaries are inclusive on the lower side.
 */
export const DELTA_BUCKETS = [
  { key: 'deep', label: '深虚值', min: 0, max: 0.15, hint: '被行权概率低，权利金薄' },
  { key: 'otm', label: '虚值', min: 0.15, max: 0.3, hint: '常见卖 put 区间' },
  { key: 'near', label: '平值附近', min: 0.3, max: 0.5, hint: '权利金厚，被行权概率高' },
  { key: 'itm', label: '实值', min: 0.5, max: Infinity, hint: '已实值，接近持有标的' },
] as const

export function deltaBucket(delta: number | null): (typeof DELTA_BUCKETS)[number] | null {
  if (delta === null || !Number.isFinite(delta)) return null
  const magnitude = Math.abs(delta)
  return DELTA_BUCKETS.find((bucket) => magnitude >= bucket.min && magnitude < bucket.max) ?? null
}

/**
 * Premium per unit of margin actually at risk on a short put, measured against
 * the strike rather than the spot: a cash-secured put ties up roughly
 * `strike * multiplier`, so this is the income rate on that capital. Returns
 * `null` rather than a misleading zero when the premium is missing.
 */
export function premiumYieldOnStrike(contract: OptionChainContract): number | null {
  if (!(contract.strike > 0) || !(contract.last > 0)) return null
  return contract.last / contract.strike
}

/** Annualized premium yield for a short position, using calendar days. */
export function annualizedPremiumYield(contract: OptionChainContract): number | null {
  const perCycle = premiumYieldOnStrike(contract)
  if (perCycle === null || !(contract.timeToExpiry > 0)) return null
  return perCycle / contract.timeToExpiry
}

export function daysToExpiry(contract: OptionChainContract): number | null {
  if (!(contract.timeToExpiry > 0)) return null
  return Math.round(contract.timeToExpiry * 365)
}

/**
 * Volatility points of premium collected per unit of delta risk: premium rate
 * divided by the absolute delta. A high ratio means the market is paying a lot
 * for a small directional bet; a low ratio means most of the premium is
 * compensation for being close to the money.
 */
export function premiumPerDelta(contract: OptionChainContract): number | null {
  const rate = premiumYieldOnStrike(contract)
  if (rate === null || contract.delta === null) return null
  const magnitude = Math.abs(contract.delta)
  if (!(magnitude > 1e-9)) return null
  return rate / magnitude
}

/**
 * Rows for the selected kind across **all** selected expiries.
 *
 * Ordering puts expiry first so a multi-expiry view reads as one block per
 * expiry rather than interleaving strikes that are months apart, and strike
 * second so each block still scans left to right.
 */
export function contractsFor(
  contracts: OptionChainContract[],
  kind: 'C' | 'P',
  expiryMonths: readonly string[],
): OptionChainContract[] {
  const wanted = new Set(expiryMonths)
  return contracts
    .filter((contract) => contract.kind === kind && wanted.has(contract.expiryMonth))
    .sort(
      (left, right) =>
        left.expiryMonth.localeCompare(right.expiryMonth) || left.strike - right.strike,
    )
}

/** Spread of implied volatility across strikes, a compact skew descriptor. */
export function volatilitySpread(contracts: OptionChainContract[]): number | null {
  const values = contracts.map((contract) => contract.volatility).filter((value): value is number => value !== null)
  if (values.length < 2) return null
  const lowest = Math.min(...values)
  const highest = Math.max(...values)
  return highest - lowest
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

export function formatNumber(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toFixed(digits)
}

export function formatSignedPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${(value * 100).toFixed(digits)}%`
}

/** `2026-12-23` → `12月` so a merged table reads as one block per expiry. */
export function expiryLabel(contract: OptionChainContract): string {
  if (contract.expiry) {
    const month = Number(contract.expiry.slice(5, 7))
    return `${month}月`
  }
  const month = Number(contract.expiryMonth.slice(2, 4))
  return Number.isFinite(month) ? `${month}月` : contract.expiryMonth
}

/** One expiry's own forward, ATM volatility and skew. */
export type OptionExpirySummary = {
  expiryMonth: string
  label: string
  forward: number | null
  basis: 'forward' | 'spot' | null
  atmStrike: number | null
  atmVolatility: number | null
  skew: number | null
  priced: number
  total: number
}

/**
 * Per-expiry forward and skew for a multi-expiry selection.
 *
 * The forward is a property of one expiry (each board has its own parity
 * pairs), so a single "the forward" would be wrong as soon as two expiries are
 * shown. Returns one entry per expiry in the selection, in expiry order.
 */
export function expirySummaries(
  contracts: OptionChainContract[],
  kind: 'C' | 'P',
  expiryMonths: readonly string[],
  spot: number | null,
): OptionExpirySummary[] {
  return [...expiryMonths].sort().map((expiryMonth) => {
    const all = contracts.filter((contract) => contract.expiryMonth === expiryMonth)
    const rows = all.filter((contract) => contract.kind === kind).sort((a, b) => a.strike - b.strike)
    const sample = all[0]
    const pricedRows = rows.filter((row) => row.volatility !== null)
    const atm =
      spot !== null && spot > 0 && pricedRows.length > 0
        ? pricedRows.reduce((best, row) =>
            Math.abs(row.strike - spot) < Math.abs(best.strike - spot) ? row : best,
          )
        : null
    return {
      expiryMonth,
      label: sample ? expiryLabel(sample) : expiryMonth,
      forward: sample?.forward ?? null,
      basis: sample?.pricingBasis ?? null,
      atmStrike: atm ? atm.strike : null,
      atmVolatility: atm ? atm.volatility : null,
      skew: volatilitySpread(rows),
      priced: pricedRows.length,
      total: rows.length,
    }
  })
}
