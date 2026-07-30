export type BuyPointDecisionStatus =
  | '不宜追高'
  | '暂不接飞刀'
  | '等待反转确认'
  | '可考虑分批试仓'
  | '趋势回踩可观察'
  | '进入观察区'
  | '流动性不足'
  | '暂无清晰买点'

export interface BuyPointConfig {
  minimumBars: number
  windows: {
    shortReturn: number
    downDays: number
    support: number
    mediumTrend: number
    rsi: number
    atr: number
    volumeShort: number
    volumeLong: number
    slopeLookback: number
  }
  thresholds: {
    oversoldRsi: number
    weakRsi: number
    overboughtRsi: number
    deepDrawdownPct: number
    moderateDrawdownPct: number
    denseDownDays: number
    nearSupportAtr: number
    volumeExpansionRatio: number
    volumeContractionRatio: number
    distributionVolumeRatio: number
    upDownVolumeRatio: number
    minAverageAmount20: number
    minAverageTurnover20: number
    minLiquidityCoverage: number
    highVolatilityAtrPct: number
    maxMa20PremiumPct: number
    maxLowReboundPct: number
    supportZoneAtr: number
    invalidationAtr: number
  }
  scores: Record<string, number>
  decisions: {
    minimumSetupForDip: number
    minimumSetupForEntry: number
    minimumConfirmationForEntry: number
    minimumTotalForEntry: number
    ma20PullbackPct: number
  }
}

export interface NormalizedKlineRow {
  date: string
  close: number
  open: number
  high: number
  low: number
  volume: number | null
  amount: number | null
  turnover: number | null
}

export interface BuyPointFlags {
  rsiOversold: boolean
  rsiWeak: boolean
  deepDrawdown: boolean
  moderateDrawdown: boolean
  denseDownDays: boolean
  moderateDownDays: boolean
  nearSupport: boolean
  bullishDay: boolean
  reclaimMa5: boolean
  breakPreviousHigh: boolean
  positiveShortReturn: boolean
  volumeExpansion: boolean
  volumeContraction: boolean
  upVolumeDominant: boolean
  distributionRisk: boolean
  lowLiquidity: boolean
  aboveMa20: boolean
  ma20AboveMa60: boolean
  fallingTrend: boolean
  breakdown: boolean
  highVolatility: boolean
  overextended: boolean
}

export interface BuyPointAnalysis {
  date: string
  bars: number
  close: number
  decision: { status: BuyPointDecisionStatus; reason: string }
  scores: { total: number; setup: number; confirmation: number; trend: number; riskPenalty: number }
  returns: { day3: number; day5: number; day10: number; day20: number }
  decline: {
    downDays10: number
    downDayReturn10: number
    consecutiveDown: number
    consecutiveReturn: number
    drawdown20: number
    rebound20: number
    reboundFromDate: string
    reboundBars: number
  }
  indicators: {
    ma5: number
    ma10: number
    ma20: number
    ma60: number
    ma20SlopePct: number
    rsi14: number
    atr14: number
    atrPct: number
    volumeRatio: number | null
    volumeShortRatio: number | null
    latestVolume: number | null
    volumeMa5: number | null
    volumeMa20: number | null
    upDownVolumeRatio: number | null
    latestAmount: number | null
    amountMa20: number | null
    latestTurnover: number | null
    turnoverMa20: number | null
    liquidityCoverage: number
  }
  levels: { supportZone: [number, number]; confirmationTrigger: number; invalidation: number }
  flags: BuyPointFlags
  evidence: string[]
}

export type TradeAction = 'build' | 'add' | 'hold' | 'reduce' | 'exit' | 'watch'

export interface TradeAdvice {
  action: TradeAction
  label: string
  tone: 'positive' | 'warning' | 'danger' | 'neutral'
  summary: string
  buyLabel: string
  buySummary: string
  holdingLabel: string
  holdingSummary: string
}

export function analyzeBuyPoint(rawRows: unknown[], config: BuyPointConfig): BuyPointAnalysis {
  const rows = normalizeKlineRows(rawRows)
  const { windows, thresholds, scores, decisions } = config
  const requiredBars = Math.max(config.minimumBars, windows.mediumTrend + windows.slopeLookback)
  if (rows.length < requiredBars) throw new Error(`need at least ${requiredBars} usable daily K-line bars, received ${rows.length}`)

  const latest = rows.at(-1) as NormalizedKlineRow
  const previous = rows.at(-2) as NormalizedKlineRow
  const closes = rows.map((row) => row.close)
  const ma5 = average(closes.slice(-5))
  const ma10 = average(closes.slice(-10))
  const ma20 = average(closes.slice(-windows.support))
  const ma60 = average(closes.slice(-windows.mediumTrend))
  const previousMa5 = average(closes.slice(-6, -1))
  const earlierMa20 = average(closes.slice(-(windows.support + windows.slopeLookback), -windows.slopeLookback))
  const supportRows = rows.slice(-windows.support)
  const low20 = Math.min(...supportRows.map((row) => row.low))
  const high20 = Math.max(...supportRows.map((row) => row.high))
  const low20Close = Math.min(...supportRows.map((row) => row.close))
  const previousLow20 = Math.min(...rows.slice(-(windows.support + 1), -1).map((row) => row.low))
  const atr14 = wilderAtr(rows, windows.atr)
  const rsi14 = wilderRsi(closes, windows.rsi)
  const ret3 = percentChange(latest.close, closes.at(-(windows.shortReturn + 1)) as number)
  const ret5 = percentChange(latest.close, closes.at(-6) as number)
  const ret10 = percentChange(latest.close, closes.at(-11) as number)
  const ret20 = percentChange(latest.close, closes.at(-21) as number)
  const drawdown20 = percentChange(latest.close, high20)
  const rebound20 = percentChange(latest.close, low20Close)
  const downDays10 = countDownDays(closes, windows.downDays)
  const consecutiveDown = countConsecutiveDown(closes)
  const low20CloseIndex = findLastCloseIndex(rows, low20Close)
  const volume = calculateVolumeStats(rows, windows.volumeShort, windows.volumeLong)
  const ma20DistancePct = percentChange(latest.close, ma20)
  const atrPct = atr14 / latest.close * 100

  const flags: BuyPointFlags = {
    rsiOversold: rsi14 <= thresholds.oversoldRsi,
    rsiWeak: rsi14 <= thresholds.weakRsi,
    deepDrawdown: drawdown20 <= thresholds.deepDrawdownPct,
    moderateDrawdown: drawdown20 <= thresholds.moderateDrawdownPct,
    denseDownDays: downDays10 >= thresholds.denseDownDays,
    moderateDownDays: downDays10 >= Math.max(1, thresholds.denseDownDays - 1),
    nearSupport: latest.close - low20 <= thresholds.nearSupportAtr * atr14,
    bullishDay: latest.close > latest.open && latest.close > previous.close,
    reclaimMa5: latest.close >= ma5 && previous.close < previousMa5,
    breakPreviousHigh: latest.close > previous.high,
    positiveShortReturn: ret3 > 0,
    volumeExpansion: latest.close > previous.close && volume.latestRatio !== null && volume.latestRatio >= thresholds.volumeExpansionRatio,
    volumeContraction: latest.close < previous.close && volume.latestRatio !== null && volume.latestRatio <= thresholds.volumeContractionRatio,
    upVolumeDominant: volume.upDownRatio !== null && volume.upDownRatio >= thresholds.upDownVolumeRatio,
    distributionRisk: latest.close < previous.close && volume.latestRatio !== null && volume.latestRatio >= thresholds.distributionVolumeRatio,
    lowLiquidity: (volume.amountCoverage >= thresholds.minLiquidityCoverage && volume.amountMa20 !== null && volume.amountMa20 < thresholds.minAverageAmount20)
      || (volume.amountCoverage < thresholds.minLiquidityCoverage && volume.turnoverCoverage >= thresholds.minLiquidityCoverage
        && volume.turnoverMa20 !== null && volume.turnoverMa20 < thresholds.minAverageTurnover20),
    aboveMa20: latest.close >= ma20,
    ma20AboveMa60: ma20 >= ma60,
    fallingTrend: latest.close < ma20 && ma20 < ma60 && ma20 < earlierMa20,
    breakdown: latest.close < previousLow20,
    highVolatility: atrPct >= thresholds.highVolatilityAtrPct,
    overextended: (ma20DistancePct >= thresholds.maxMa20PremiumPct || rebound20 >= thresholds.maxLowReboundPct)
      && rsi14 >= thresholds.overboughtRsi,
  }

  const setupScore = (flags.rsiOversold ? scores.rsiOversold : flags.rsiWeak ? scores.rsiWeak : 0)
    + (flags.deepDrawdown ? scores.deepDrawdown : flags.moderateDrawdown ? scores.moderateDrawdown : 0)
    + (flags.denseDownDays ? scores.denseDownDays : flags.moderateDownDays ? scores.moderateDownDays : 0)
    + (flags.nearSupport ? scores.nearSupport : 0)
  const confirmationScore = (flags.bullishDay ? scores.bullishDay : 0)
    + (flags.reclaimMa5 ? scores.reclaimMa5 : 0)
    + (flags.breakPreviousHigh ? scores.breakPreviousHigh : 0)
    + (flags.positiveShortReturn ? scores.positiveShortReturn : 0)
    + (flags.volumeExpansion ? scores.volumeExpansion : 0)
    + (flags.upVolumeDominant ? scores.upVolumeDominant : 0)
    + (flags.volumeContraction ? scores.pullbackVolumeContraction : 0)
  const trendScore = (flags.aboveMa20 ? scores.aboveMa20 : 0) + (flags.ma20AboveMa60 ? scores.ma20AboveMa60 : 0)
  const riskPenalty = (flags.fallingTrend ? scores.fallingTrendPenalty : 0)
    + (flags.breakdown ? scores.breakdownPenalty : 0)
    + (flags.highVolatility ? scores.highVolatilityPenalty : 0)
    + (flags.distributionRisk ? scores.distributionPenalty : 0)
    + (flags.lowLiquidity ? scores.lowLiquidityPenalty : 0)
    + (flags.overextended ? scores.overextendedPenalty : 0)
  const totalScore = clamp(setupScore + confirmationScore + trendScore - riskPenalty, 0, 100)
  const decision = decide({ flags, setupScore, confirmationScore, totalScore, ma20DistancePct }, decisions)

  return {
    date: latest.date,
    bars: rows.length,
    close: latest.close,
    decision,
    scores: { total: totalScore, setup: setupScore, confirmation: confirmationScore, trend: trendScore, riskPenalty },
    returns: { day3: ret3, day5: ret5, day10: ret10, day20: ret20 },
    decline: {
      downDays10,
      downDayReturn10: compoundedDownDayReturn(closes, windows.downDays),
      consecutiveDown,
      consecutiveReturn: consecutiveDown > 0 ? percentChange(latest.close, closes.at(-(consecutiveDown + 1)) as number) : 0,
      drawdown20,
      rebound20,
      reboundFromDate: (rows[low20CloseIndex] as NormalizedKlineRow).date,
      reboundBars: rows.length - 1 - low20CloseIndex,
    },
    indicators: {
      ma5, ma10, ma20, ma60, ma20SlopePct: percentChange(ma20, earlierMa20), rsi14, atr14, atrPct,
      volumeRatio: volume.latestRatio, volumeShortRatio: volume.shortRatio, latestVolume: latest.volume,
      volumeMa5: volume.volumeMa5, volumeMa20: volume.volumeMa20, upDownVolumeRatio: volume.upDownRatio,
      latestAmount: latest.amount, amountMa20: volume.amountMa20, latestTurnover: latest.turnover,
      turnoverMa20: volume.turnoverMa20, liquidityCoverage: Math.max(volume.amountCoverage, volume.turnoverCoverage),
    },
    levels: {
      supportZone: [low20, low20 + thresholds.supportZoneAtr * atr14],
      confirmationTrigger: Math.max(ma5, previous.high),
      invalidation: low20 - thresholds.invalidationAtr * atr14,
    },
    flags,
    evidence: buildEvidence(flags),
  }
}

export function buildTradeAdvice(analysis: BuyPointAnalysis, hasPosition: boolean, costPrice: number | null = null): TradeAdvice {
  const profitable = costPrice !== null && costPrice > 0 && analysis.close > costPrice
  const buy = buyAdvice(analysis)
  const holding = holdingAdvice(analysis, profitable)
  return hasPosition ? { ...holding, buyLabel: buy.label, buySummary: buy.summary, holdingLabel: holding.label, holdingSummary: holding.summary }
    : { ...buy, buyLabel: buy.label, buySummary: buy.summary, holdingLabel: holding.label, holdingSummary: holding.summary }
}

export function normalizeKlineRows(rawRows: unknown[]): NormalizedKlineRow[] {
  const byDate = new Map<string, NormalizedKlineRow>()
  for (const raw of Array.isArray(rawRows) ? rawRows : []) {
    const row = Array.isArray(raw) ? {
      date: dateString(raw[0]), close: finite(raw[1]), open: finite(raw[2]), high: finite(raw[3]), low: finite(raw[4]),
      volume: finite(raw[5]), turnover: finite(raw[6]), amount: finite(raw[7]),
    } : objectRow(raw)
    if (!row || !row.date || row.close === null || row.open === null || row.high === null || row.low === null
      || row.close <= 0 || row.open <= 0 || row.high <= 0 || row.low <= 0) continue
    byDate.set(row.date, { ...row, close: row.close, open: row.open, high: row.high, low: row.low })
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date))
}

function buyAdvice(analysis: BuyPointAnalysis): Omit<TradeAdvice, 'buyLabel' | 'buySummary' | 'holdingLabel' | 'holdingSummary'> {
  const status = analysis.decision.status
  if (status === '可考虑分批试仓') return { action: 'build', label: '分批试仓候选', tone: 'positive', summary: analysis.decision.reason }
  if (status === '趋势回踩可观察') return { action: 'build', label: '等待回踩确认', tone: 'positive', summary: analysis.decision.reason }
  if (status === '暂不接飞刀') return { action: 'watch', label: '暂停买入', tone: 'danger', summary: analysis.decision.reason }
  if (status === '流动性不足') return { action: 'watch', label: '流动性不足：暂不买入', tone: 'warning', summary: analysis.decision.reason }
  if (status === '不宜追高') return { action: 'watch', label: '不宜追高', tone: 'warning', summary: analysis.decision.reason }
  return { action: 'watch', label: status, tone: 'neutral', summary: analysis.decision.reason }
}

function holdingAdvice(analysis: BuyPointAnalysis, profitable: boolean): Omit<TradeAdvice, 'buyLabel' | 'buySummary' | 'holdingLabel' | 'holdingSummary'> {
  if (analysis.flags.breakdown) return { action: 'exit', label: '破位：退出/显著减仓', tone: 'danger', summary: '当前收盘已跌破此前 20 日低点；风险动作优先于超跌或加仓信号。' }
  if (analysis.flags.fallingTrend) return { action: 'reduce', label: '弱势：减仓防守', tone: 'danger', summary: '价格低于 MA20，MA20 低于 MA60 且仍在下行；反转确认前不宜补仓。' }
  if (analysis.flags.distributionRisk) return { action: 'reduce', label: '放量下跌：降低仓位', tone: 'danger', summary: '下跌日成交量达到 20 日均量的风险阈值，卖压放大；等待量价关系恢复后再评估。' }
  if (analysis.flags.lowLiquidity) return { action: 'reduce', label: '流动性偏低：控制仓位', tone: 'warning', summary: '近 20 日成交额或换手率低于门槛，大仓位可能难以按计划成交，应控制退出难度。' }
  if (analysis.flags.overextended) return { action: 'reduce', label: profitable ? '偏热：分批止盈' : '偏热：收紧保护位', tone: 'warning', summary: '反弹幅度、均线乖离和 RSI 偏热，继续追涨的盈亏比下降。' }
  if (analysis.decision.status === '可考虑分批试仓' || analysis.decision.status === '趋势回踩可观察') {
    return { action: 'add', label: '确认后可分批加仓', tone: 'positive', summary: '没有破位或空头风险否决，且买入侧出现反转/回踩确认。' }
  }
  return { action: 'hold', label: '持有观察', tone: 'neutral', summary: '尚未触发破位卖出，也没有形成足够强的加仓确认。' }
}

function decide(
  state: { flags: BuyPointFlags; setupScore: number; confirmationScore: number; totalScore: number; ma20DistancePct: number },
  decisions: BuyPointConfig['decisions'],
): { status: BuyPointDecisionStatus; reason: string } {
  const { flags, setupScore, confirmationScore, totalScore, ma20DistancePct } = state
  if (flags.lowLiquidity) return { status: '流动性不足', reason: '近 20 日成交额或换手率低于流动性门槛，买入后可能难以按计划退出' }
  if (flags.overextended) return { status: '不宜追高', reason: '反弹幅度、均线乖离和 RSI 显示短线偏热，等待回踩' }
  if (flags.breakdown && confirmationScore < decisions.minimumConfirmationForEntry) return { status: '暂不接飞刀', reason: '收盘跌破此前 20 日低点，且反转确认不足' }
  if (flags.fallingTrend && confirmationScore < decisions.minimumConfirmationForEntry) return { status: '等待反转确认', reason: '价格、MA20 与 MA60 仍为空头排列' }
  const volumeConfirmed = flags.volumeExpansion || flags.upVolumeDominant
  if (setupScore >= decisions.minimumSetupForEntry && confirmationScore >= decisions.minimumConfirmationForEntry && totalScore >= decisions.minimumTotalForEntry && volumeConfirmed) {
    return { status: '可考虑分批试仓', reason: '超跌条件和价格反转确认同时成立；仍需按失效位控制风险' }
  }
  if (flags.aboveMa20 && flags.ma20AboveMa60 && Math.abs(ma20DistancePct) <= decisions.ma20PullbackPct && confirmationScore >= decisions.minimumConfirmationForEntry && volumeConfirmed) {
    return { status: '趋势回踩可观察', reason: '中期趋势未坏，价格靠近 MA20 且出现短线确认' }
  }
  if (setupScore >= decisions.minimumSetupForDip) return { status: '进入观察区', reason: '已出现一定超跌条件，但反转证据尚不足' }
  return { status: '暂无清晰买点', reason: '超跌或趋势回踩条件不足，等待更明确的价格结构' }
}

function objectRow(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  return {
    date: String(value.date ?? ''), close: finite(value.close), open: finite(value.open), high: finite(value.high), low: finite(value.low),
    volume: finite(value.volume), amount: finite(value.amount), turnover: finite(value.turnover),
  }
}

function dateString(value: unknown): string {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp)) return ''
  return new Date(timestamp).toISOString().slice(0, 10)
}

function buildEvidence(flags: BuyPointFlags): string[] {
  const labels: Partial<Record<keyof BuyPointFlags, string>> = {
    rsiOversold: 'RSI14 超卖', deepDrawdown: '20 日回撤较深', denseDownDays: '近 10 日下跌密集', nearSupport: '靠近 20 日低点',
    bullishDay: '当日阳线且高于前收', reclaimMa5: '重新站上 MA5', breakPreviousHigh: '收盘突破前一日高点', positiveShortReturn: '近 3 日转正',
    volumeExpansion: '上涨伴随量能放大', fallingTrend: 'MA20/MA60 空头且 MA20 下行', breakdown: '跌破此前 20 日低点', highVolatility: 'ATR 波动偏高', overextended: '反弹/均线乖离偏热',
    volumeContraction: '下跌缩量', upVolumeDominant: '上涨日量能强于下跌日', distributionRisk: '放量下跌', lowLiquidity: '流动性不足',
  }
  return (Object.keys(labels) as Array<keyof BuyPointFlags>).filter((key) => flags[key]).map((key) => labels[key] as string)
}

function wilderRsi(closes: number[], period: number): number {
  const changes = closes.slice(1).map((value, index) => value - closes[index])
  let averageGain = average(changes.slice(0, period).map((change) => Math.max(change, 0)))
  let averageLoss = average(changes.slice(0, period).map((change) => Math.max(-change, 0)))
  for (const change of changes.slice(period)) {
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period
  }
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100
  return 100 - 100 / (1 + averageGain / averageLoss)
}

function wilderAtr(rows: NormalizedKlineRow[], period: number): number {
  const ranges = rows.map((row, index) => index === 0 ? row.high - row.low : Math.max(
    row.high - row.low, Math.abs(row.high - rows[index - 1].close), Math.abs(row.low - rows[index - 1].close),
  ))
  let value = average(ranges.slice(1, period + 1))
  for (const range of ranges.slice(period + 1)) value = (value * (period - 1) + range) / period
  return value
}

function calculateVolumeStats(rows: NormalizedKlineRow[], shortWindow: number, longWindow: number) {
  const recent = rows.slice(-longWindow)
  const volumes = recent.map((row) => validNonNegative(row.volume))
  const volumeMa20 = nullableAverage(volumes)
  const volumeMa5 = nullableAverage(volumes.slice(-shortWindow))
  const latestVolume = validNonNegative((rows.at(-1) as NormalizedKlineRow).volume)
  const upVolumes: number[] = []
  const downVolumes: number[] = []
  for (let index = 1; index < recent.length; index += 1) {
    const value = validNonNegative(recent[index].volume)
    if (value === null) continue
    if (recent[index].close > recent[index - 1].close) upVolumes.push(value)
    else if (recent[index].close < recent[index - 1].close) downVolumes.push(value)
  }
  const upAverage = upVolumes.length ? average(upVolumes) : null
  const downAverage = downVolumes.length ? average(downVolumes) : null
  const amounts = recent.map((row) => validNonNegative(row.amount))
  const turnovers = recent.map((row) => validNonNegative(row.turnover))
  return {
    latestRatio: latestVolume !== null && volumeMa20 ? latestVolume / volumeMa20 : null,
    shortRatio: volumeMa5 !== null && volumeMa20 ? volumeMa5 / volumeMa20 : null,
    volumeMa5,
    volumeMa20,
    upDownRatio: upAverage !== null && downAverage ? upAverage / downAverage : null,
    amountMa20: nullableAverage(amounts),
    turnoverMa20: nullableAverage(turnovers),
    amountCoverage: amounts.filter((value) => value !== null).length / longWindow,
    turnoverCoverage: turnovers.filter((value) => value !== null).length / longWindow,
  }
}

function countDownDays(closes: number[], window: number): number {
  const values = closes.slice(-(window + 1))
  return values.slice(1).filter((value, index) => value < values[index]).length
}

function countConsecutiveDown(closes: number[]): number {
  let count = 0
  for (let index = closes.length - 1; index > 0 && closes[index] < closes[index - 1]; index -= 1) count += 1
  return count
}

function compoundedDownDayReturn(closes: number[], window: number): number {
  const values = closes.slice(-(window + 1))
  return values.slice(1).reduce((factor, value, index) => value / values[index] < 1 ? factor * value / values[index] : factor, 1) * 100 - 100
}

function findLastCloseIndex(rows: NormalizedKlineRow[], close: number): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].close === close) return index
  }
  return 0
}

function average(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / values.length }
function percentChange(value: number, base: number): number { return (value / base - 1) * 100 }
function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
function validNonNegative(value: number | null): number | null { return value !== null && Number.isFinite(value) && value >= 0 ? value : null }
function nullableAverage(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value !== null)
  return valid.length ? average(valid) : null
}
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)) }
