export type OptionSide = 'buy' | 'sell'
export type OptionType = 'call' | 'put'

export const STRATEGY_CHART_CAPITAL = 100_000_000

export type StrategyLeg = {
  id: string
  side: OptionSide
  type: OptionType
  strike: number
  expiration: string
  premium: number
  quantity: number
  multiplier: number
}

export type StrategyMetrics = {
  netPremiumCash: number
  timeCostCash: number
  timeCostAnnualized: number | null
  breakevens: number[]
  nearestBreakevenDistancePct: number | null
  minimumDaysToExpiry: number | null
  maximumDaysToExpiry: number | null
  minimumWeeksToExpiry: number | null
  maximumWeeksToExpiry: number | null
  mixedExpirations: boolean
}

export function daysToExpiry(expiration: string, now = new Date()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return null
  const expiry = new Date(`${expiration}T00:00:00`)
  if (!Number.isFinite(expiry.getTime())) return null
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.max(0, Math.ceil((expiry.getTime() - today.getTime()) / 86_400_000))
}

export function intrinsicValue(type: OptionType, spot: number, strike: number): number {
  if (!Number.isFinite(spot) || !Number.isFinite(strike)) return 0
  return type === 'call' ? Math.max(0, spot - strike) : Math.max(0, strike - spot)
}

export function legMoneynessDistancePct(leg: Pick<StrategyLeg, 'type' | 'strike'>, spot: number): number | null {
  if (!(spot > 0) || !(leg.strike > 0)) return null
  return leg.type === 'call'
    ? (leg.strike / spot - 1) * 100
    : (spot / leg.strike - 1) * 100
}

export function strategyPayoffAtExpiry(legs: StrategyLeg[], price: number): number {
  return legs.reduce((total, leg) => {
    const direction = leg.side === 'buy' ? 1 : -1
    const unitPayoff = intrinsicValue(leg.type, price, leg.strike) - leg.premium
    return total + direction * unitPayoff * leg.quantity * leg.multiplier
  }, 0)
}

/**
 * Cash paid to open one complete strategy package. Each leg's quantity and
 * multiplier stay in their stated ratio.
 */
export function strategyEntryCapital(legs: StrategyLeg[]): number {
  return legs
    .filter((leg) => leg.strike > 0 && leg.premium >= 0 && leg.quantity > 0 && leg.multiplier > 0)
    .reduce((total, leg) => total + (leg.side === 'buy' ? 1 : -1) * leg.premium * leg.quantity * leg.multiplier, 0)
}

/**
 * Percentage return at expiry after buying as many complete strategy packages
 * as a fixed capital amount permits. Any residual cash is assumed to earn no
 * return, which keeps the denominator at the full 100 million investment.
 */
export function strategyReturnRateAtExpiry(legs: StrategyLeg[], price: number, capital = STRATEGY_CHART_CAPITAL): number | null {
  const entryCapital = strategyEntryCapital(legs)
  const packageCount = entryCapital > 0 && capital > 0 ? Math.floor(capital / entryCapital) : 0
  return packageCount > 0 ? strategyPayoffAtExpiry(legs, price) * packageCount / capital * 100 : null
}

export function calculateStrategyMetrics(legs: StrategyLeg[], spot: number, now = new Date()): StrategyMetrics {
  const validLegs = legs.filter((leg) => leg.strike > 0 && leg.premium >= 0 && leg.quantity > 0 && leg.multiplier > 0)
  const netPremiumCash = strategyEntryCapital(validLegs)
  const timeCostCash = validLegs.reduce((total, leg) => {
    const extrinsic = Math.max(0, leg.premium - intrinsicValue(leg.type, spot, leg.strike))
    return total + (leg.side === 'buy' ? 1 : -1) * extrinsic * leg.quantity * leg.multiplier
  }, 0)
  const days = validLegs.map((leg) => daysToExpiry(leg.expiration, now)).filter((value): value is number => value !== null)
  const minimumDaysToExpiry = days.length ? Math.min(...days) : null
  const maximumDaysToExpiry = days.length ? Math.max(...days) : null
  const grossPremiumCash = validLegs.reduce((total, leg) => total + leg.premium * leg.quantity * leg.multiplier, 0)
  const timeCostAnnualized = maximumDaysToExpiry && grossPremiumCash > 0
    ? timeCostCash / grossPremiumCash * 365 / maximumDaysToExpiry
    : null
  const breakevens = findBreakevens(validLegs, spot)
  const nearestBreakevenDistancePct = spot > 0 && breakevens.length > 0
    ? Math.min(...breakevens.map((point) => Math.abs((point / spot - 1) * 100)))
    : null
  const expirationCount = new Set(validLegs.map((leg) => leg.expiration)).size
  return {
    netPremiumCash,
    timeCostCash,
    timeCostAnnualized,
    breakevens,
    nearestBreakevenDistancePct,
    minimumDaysToExpiry,
    maximumDaysToExpiry,
    minimumWeeksToExpiry: minimumDaysToExpiry === null ? null : minimumDaysToExpiry / 7,
    maximumWeeksToExpiry: maximumDaysToExpiry === null ? null : maximumDaysToExpiry / 7,
    mixedExpirations: expirationCount > 1,
  }
}

function findBreakevens(legs: StrategyLeg[], spot: number): number[] {
  if (legs.length === 0) return []
  const highestStrike = Math.max(...legs.map((leg) => leg.strike), spot || 0, 1)
  const points = new Set<number>([0, ...legs.map((leg) => leg.strike), highestStrike * 2])
  const ordered = [...points].sort((a, b) => a - b)
  const roots: number[] = []
  for (let index = 0; index < ordered.length - 1; index++) {
    const left = ordered[index]
    const right = ordered[index + 1]
    const leftPayoff = strategyPayoffAtExpiry(legs, left)
    const rightPayoff = strategyPayoffAtExpiry(legs, right)
    if (Math.abs(leftPayoff) < 0.000001) roots.push(left)
    if (leftPayoff * rightPayoff < 0) {
      const root = left + (right - left) * Math.abs(leftPayoff) / (Math.abs(leftPayoff) + Math.abs(rightPayoff))
      roots.push(root)
    }
  }
  const last = ordered[ordered.length - 1]
  if (Math.abs(strategyPayoffAtExpiry(legs, last)) < 0.000001) roots.push(last)
  return roots.filter((root, index, all) => index === 0 || Math.abs(root - all[index - 1]) > 0.001)
}
