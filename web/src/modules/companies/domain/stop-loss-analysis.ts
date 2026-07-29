export type StopLossRiskLevel = 'high' | 'down' | 'weak' | 'stable'
export type PositionAction = 'build' | 'add' | 'hold' | 'reduce' | 'exit' | 'watch'
export type PositionReason = 'trend' | 'position' | 'takeProfit' | 'risk' | 'stopLoss' | 'data'

export interface StopLossRiskConfig {
  minimumBars: number
  movingAverage: {
    short: number
    long: number
    slopeDays: number
  }
  atrPeriod: number
  supportLookback: number
  drawdownLookback: number
  drawdownSignalPct: number
  supportBufferAtr: number
  riskScoreThresholds: {
    high: number
    down: number
    weak: number
  }
  atrMultipliers: Record<StopLossRiskLevel, number>
}

export type StopLossAnalysis = {
  available: false
  validBars: number
} | {
  available: true
  validBars: number
  priceDate: string
  close: number
  riskLevel: StopLossRiskLevel
  riskScore: number
  signalCount: number
  stopPrice: number
  priorSupport: number
  supportBroken: boolean
  return20Pct: number
  drawdown60Pct: number
  atrPct: number
  atr: number
  shortAverage: number
  belowShortAverage: boolean
  shortBelowLongAverage: boolean
  shortAverageFalling: boolean
}

type KlineBar = {
  timestamp: number
  close: number
  high: number
  low: number
}

export function analyzeStopLoss(rawRows: number[][], config: StopLossRiskConfig): StopLossAnalysis {
  const bars = normalizeBars(rawRows)
  if (bars.length < config.minimumBars) {
    return { available: false, validBars: bars.length }
  }

  const closes = bars.map((bar) => bar.close)
  const close = closes.at(-1) as number
  const shortPeriod = config.movingAverage.short
  const longPeriod = config.movingAverage.long
  const slopeDays = config.movingAverage.slopeDays
  const shortAverage = average(closes.slice(-shortPeriod))
  const longAverage = average(closes.slice(-longPeriod))
  const earlierShortAverage = average(closes.slice(-(shortPeriod + slopeDays), -slopeDays))
  const return20Pct = percentChange(close, closes.at(-(shortPeriod + 1)) as number)
  const drawdownCloses = closes.slice(-config.drawdownLookback)
  const drawdown60Pct = percentChange(close, Math.max(...drawdownCloses))
  const trueRangeValues = trueRanges(bars)
  const atr = average(trueRangeValues.slice(-config.atrPeriod))
  const atrPct = atr / close * 100
  const priorSupport = Math.min(...bars.slice(-(config.supportLookback + 1), -1).map((bar) => bar.low))
  const supportBroken = close < priorSupport
  const belowShortAverage = close < shortAverage
  const shortBelowLongAverage = shortAverage < longAverage
  const shortAverageFalling = shortAverage < earlierShortAverage
  const signals = [
    belowShortAverage,
    shortBelowLongAverage,
    shortAverageFalling,
    return20Pct < 0,
    drawdown60Pct <= -config.drawdownSignalPct,
    supportBroken,
  ]
  const riskScore = signals.filter(Boolean).length
  const riskLevel = riskLevelForScore(riskScore, config)
  const volatilityStop = close - config.atrMultipliers[riskLevel] * atr
  const supportStop = priorSupport - config.supportBufferAtr * atr

  return {
    available: true,
    validBars: bars.length,
    priceDate: new Date((bars.at(-1) as KlineBar).timestamp).toISOString().slice(0, 10),
    close,
    riskLevel,
    riskScore,
    signalCount: signals.length,
    stopPrice: Math.max(volatilityStop, supportStop),
    priorSupport,
    supportBroken,
    return20Pct,
    drawdown60Pct,
    atrPct,
    atr,
    shortAverage,
    belowShortAverage,
    shortBelowLongAverage,
    shortAverageFalling,
  }
}

export interface PositionSizingConfig {
  defaultAccountRiskPct: number
  defaultMaxStockPositionPct: number
  buildTranches: number
  takeProfitRemainingRatio: number
  riskReduceRemainingRatio: number
  overextendedAtr: number
}

export interface PositionRecommendationInput {
  currentPositionPct: number
  costPrice: number | null
  accountRiskPct: number
  maxStockPositionPct: number
}

export interface PositionRecommendation {
  action: PositionAction
  reason: PositionReason
  suggestedPositionPct: number
  riskBasedMaxPositionPct: number
  overextended: boolean
}

export function recommendPosition(
  analysis: StopLossAnalysis,
  input: PositionRecommendationInput,
  config: PositionSizingConfig,
): PositionRecommendation {
  const currentPositionPct = clamp(input.currentPositionPct, 0, 100)
  if (!analysis.available) {
    return {
      action: currentPositionPct > 0 ? 'hold' : 'watch',
      reason: 'data',
      suggestedPositionPct: currentPositionPct,
      riskBasedMaxPositionPct: 0,
      overextended: false,
    }
  }

  const stopDistancePct = Math.max((analysis.close - analysis.stopPrice) / analysis.close * 100, 0.1)
  const riskBasedMaxPositionPct = Math.min(
    clamp(input.maxStockPositionPct, 0, 100),
    clamp(input.accountRiskPct, 0, 100) / stopDistancePct * 100,
  )
  const tranche = riskBasedMaxPositionPct / Math.max(1, config.buildTranches)
  const profitable = input.costPrice !== null && input.costPrice > 0 && analysis.close > input.costPrice
  const overextended = analysis.close > analysis.shortAverage + config.overextendedAtr * analysis.atr

  if (currentPositionPct <= 0) {
    const canBuild = analysis.riskLevel === 'stable' && !overextended && !analysis.supportBroken
    return {
      action: canBuild ? 'build' : 'watch',
      reason: canBuild ? 'trend' : 'risk',
      suggestedPositionPct: canBuild ? tranche : 0,
      riskBasedMaxPositionPct,
      overextended,
    }
  }

  if (analysis.supportBroken) {
    return {
      action: 'exit',
      reason: profitable ? 'takeProfit' : 'stopLoss',
      suggestedPositionPct: 0,
      riskBasedMaxPositionPct,
      overextended,
    }
  }
  if (analysis.riskLevel === 'high' || analysis.riskLevel === 'down') {
    return {
      action: 'reduce',
      reason: profitable ? 'takeProfit' : 'risk',
      suggestedPositionPct: Math.min(currentPositionPct * config.riskReduceRemainingRatio, riskBasedMaxPositionPct),
      riskBasedMaxPositionPct,
      overextended,
    }
  }
  if (analysis.riskLevel === 'weak' || (overextended && profitable)) {
    return {
      action: 'reduce',
      reason: profitable ? 'takeProfit' : 'risk',
      suggestedPositionPct: Math.min(currentPositionPct * config.takeProfitRemainingRatio, riskBasedMaxPositionPct),
      riskBasedMaxPositionPct,
      overextended,
    }
  }
  if (currentPositionPct > riskBasedMaxPositionPct) {
    return {
      action: 'reduce',
      reason: 'position',
      suggestedPositionPct: riskBasedMaxPositionPct,
      riskBasedMaxPositionPct,
      overextended,
    }
  }
  if (currentPositionPct + 0.05 < riskBasedMaxPositionPct) {
    return {
      action: 'add',
      reason: 'position',
      suggestedPositionPct: Math.min(currentPositionPct + tranche, riskBasedMaxPositionPct),
      riskBasedMaxPositionPct,
      overextended,
    }
  }
  return {
    action: 'hold',
    reason: 'trend',
    suggestedPositionPct: currentPositionPct,
    riskBasedMaxPositionPct,
    overextended,
  }
}

function normalizeBars(rawRows: number[][]): KlineBar[] {
  const byTimestamp = new Map<number, KlineBar>()
  for (const row of Array.isArray(rawRows) ? rawRows : []) {
    const timestamp = Number(row?.[0])
    const close = Number(row?.[1])
    const high = Number(row?.[3])
    const low = Number(row?.[4])
    if (![timestamp, close, high, low].every((value) => Number.isFinite(value) && value > 0)) {
      continue
    }
    byTimestamp.set(timestamp, { timestamp, close, high, low })
  }
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp)
}

function riskLevelForScore(score: number, config: StopLossRiskConfig): StopLossRiskLevel {
  if (score >= config.riskScoreThresholds.high) return 'high'
  if (score >= config.riskScoreThresholds.down) return 'down'
  if (score >= config.riskScoreThresholds.weak) return 'weak'
  return 'stable'
}

function trueRanges(bars: KlineBar[]): number[] {
  return bars.map((bar, index) => index === 0
    ? bar.high - bar.low
    : Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - bars[index - 1].close),
      Math.abs(bar.low - bars[index - 1].close),
    ))
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentChange(value: number, base: number): number {
  return (value / base - 1) * 100
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum))
}
