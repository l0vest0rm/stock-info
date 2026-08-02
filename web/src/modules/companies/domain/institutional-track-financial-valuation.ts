export type InstitutionalValuationState = 'deep-value' | 'value' | 'fair' | 'expensive' | 'overvalued' | 'income-stagnant' | 'unavailable'

export type ValuationThresholds = {
  strongBuy: number
  buy: number
  watch: number
  noAdd: number
}

type FinancialRow = Record<string, unknown>

export type FinancialValuationResult = {
  status: 'rated' | 'unavailable'
  state: InstitutionalValuationState | null
  pb: number | null
  ttmProfit: number | null
  averageEquity: number | null
  roe: number | null
  normalizedPe: number | null
  reason: string
}

export type BankShareholderReturnThresholds = {
  strongBuyYieldPct: number
  buyYieldPct: number
  watchYieldPct: number
  minimumProfitCagrPct: number
}

export type BankShareholderReturnResult = {
  status: 'rated' | 'unavailable'
  state: InstitutionalValuationState | null
  dividendYield: number | null
  profitCagr: number | null
  pb: number | null
  roe: number | null
  reason: string
}

function finiteNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function positiveNumber(value: unknown): number | null {
  const numeric = finiteNumber(value)
  return numeric !== null && numeric > 0 ? numeric : null
}

function rowDate(value: FinancialRow): number | null {
  const source = value.reportDate ?? value.REPORT_DATE
  const parsed = typeof source === 'string' ? Date.parse(source) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function orderedRows(rows: FinancialRow[]): FinancialRow[] {
  return [...rows].filter((row) => rowDate(row) !== null).sort((left, right) => rowDate(right)! - rowDate(left)!)
}

function quarterlyProfit(row: FinancialRow): number | null {
  return finiteNumber(row.parentNetprofit ?? row.netProfit ?? row.PARENT_NETPROFIT ?? row.NET_PROFIT)
}

function equity(row: FinancialRow): number | null {
  return positiveNumber(row.totalParentEquity ?? row.totalEquity ?? row.TOTAL_PARENT_EQUITY ?? row.TOTAL_EQUITY)
}

function lowerIsBetter(value: number, thresholds: ValuationThresholds): InstitutionalValuationState {
  if (value <= thresholds.strongBuy) return 'deep-value'
  if (value <= thresholds.buy) return 'value'
  if (value <= thresholds.watch) return 'fair'
  if (value <= thresholds.noAdd) return 'expensive'
  return 'overvalued'
}

function higherIsBetter(value: number, thresholds: ValuationThresholds): InstitutionalValuationState {
  if (value >= thresholds.strongBuy) return 'deep-value'
  if (value >= thresholds.buy) return 'value'
  if (value >= thresholds.watch) return 'fair'
  if (value >= thresholds.noAdd) return 'expensive'
  return 'overvalued'
}

const risk: Record<Exclude<InstitutionalValuationState, 'unavailable'>, number> = {
  'deep-value': 0,
  value: 1,
  fair: 2,
  expensive: 3,
  overvalued: 4,
  'income-stagnant': 4,
}

function riskier(left: Exclude<InstitutionalValuationState, 'unavailable'>, right: Exclude<InstitutionalValuationState, 'unavailable'>): Exclude<InstitutionalValuationState, 'unavailable'> {
  return risk[left] >= risk[right] ? left : right
}

function unavailable(reason: string): FinancialValuationResult {
  return { status: 'unavailable', state: null, pb: null, ttmProfit: null, averageEquity: null, roe: null, normalizedPe: null, reason }
}

function unavailableBankReturn(reason: string, financial: FinancialValuationResult): BankShareholderReturnResult {
  return {
    status: 'unavailable',
    state: null,
    dividendYield: null,
    profitCagr: null,
    pb: financial.pb,
    roe: financial.roe,
    reason,
  }
}

function downgradeOne(state: Exclude<InstitutionalValuationState, 'unavailable'>): Exclude<InstitutionalValuationState, 'unavailable'> {
  if (state === 'deep-value') return 'value'
  if (state === 'value') return 'fair'
  if (state === 'fair') return 'expensive'
  return state
}

export function assessInstitutionalTrackBankShareholderReturn(input: {
  dividendYield: unknown
  profitCagr: unknown
  financial: FinancialValuationResult
  thresholds: BankShareholderReturnThresholds
}): BankShareholderReturnResult {
  const dividendYield = positiveNumber(input.dividendYield)
  const profitCagr = finiteNumber(input.profitCagr)
  if (dividendYield === null || profitCagr === null) {
    return unavailableBankReturn('缺少近四季股息率或完整利润预测，无法评估银行股东回报。', input.financial)
  }
  if (input.financial.status === 'unavailable' || input.financial.state === null) {
    return unavailableBankReturn(`PB/滚动 ROE 约束未就绪：${input.financial.reason}`, input.financial)
  }
  if (profitCagr < input.thresholds.minimumProfitCagrPct) {
    return {
      status: 'rated',
      state: 'income-stagnant',
      dividendYield,
      profitCagr,
      pb: input.financial.pb,
      roe: input.financial.roe,
      reason: `近四季股息率 ${dividendYield.toFixed(1)}%，但预测净利 CAGR ${profitCagr.toFixed(1)}% 低于 ${input.thresholds.minimumProfitCagrPct.toFixed(1)}% 的持续性门槛；高股息不能单独构成新增理由。${input.financial.reason}`,
    }
  }
  let state: Exclude<InstitutionalValuationState, 'unavailable'> = 'expensive'
  if (dividendYield >= input.thresholds.strongBuyYieldPct) state = 'deep-value'
  else if (dividendYield >= input.thresholds.buyYieldPct) state = 'value'
  else if (dividendYield >= input.thresholds.watchYieldPct) state = 'fair'
  if (profitCagr < 0) state = downgradeOne(state)
  state = riskier(state, input.financial.state)
  return {
    status: 'rated',
    state,
    dividendYield,
    profitCagr,
    pb: input.financial.pb,
    roe: input.financial.roe,
    reason: `近四季股息率 ${dividendYield.toFixed(1)}% 为主锚；预测净利 CAGR ${profitCagr.toFixed(1)}% 用于检验持续性${profitCagr < 0 ? '，因此股息率结论下调一档' : ''}。PB/滚动 ROE 仅作约束并取更谨慎结论。${input.financial.reason}`,
  }
}

export function assessInstitutionalTrackFinancialValuation(input: {
  pb: unknown
  incomeRows: FinancialRow[]
  balanceRows: FinancialRow[]
  pbThresholds: ValuationThresholds
  roeThresholds: ValuationThresholds
}): FinancialValuationResult {
  const pb = positiveNumber(input.pb)
  if (pb === null) return unavailable('缺少有效 PB。')
  const income = orderedRows(input.incomeRows).map(quarterlyProfit).filter((value): value is number => value !== null)
  if (income.length < 4) return unavailable('缺少连续四个单季归母净利润，不能计算滚动 ROE。')
  const ttmProfit = income.slice(0, 4).reduce((sum, value) => sum + value, 0)
  if (ttmProfit <= 0) {
    return { status: 'rated', state: 'income-stagnant', pb, ttmProfit, averageEquity: null, roe: null, normalizedPe: null, reason: '近四季归母净利润不为正，PB 不能单独构成新增理由。' }
  }
  const balances = orderedRows(input.balanceRows)
  const current = balances.find((row) => equity(row) !== null)
  if (!current) return unavailable('缺少有效股东权益，不能计算 ROE。')
  const currentDate = rowDate(current)!
  const prior = balances.find((row) => rowDate(row)! <= currentDate - 300 * 86_400_000 && equity(row) !== null)
  if (!prior) return unavailable('缺少约一年前的股东权益，不能计算平均权益 ROE。')
  const averageEquity = (equity(current)! + equity(prior)!) / 2
  const roe = ttmProfit / averageEquity * 100
  const pbState = lowerIsBetter(pb, input.pbThresholds)
  const roeState = higherIsBetter(roe, input.roeThresholds)
  const state = riskier(pbState, roeState)
  return {
    status: 'rated', state, pb, ttmProfit, averageEquity, roe, normalizedPe: null,
    reason: `PB ${pb.toFixed(2)}；近四季归母净利润 ${(ttmProfit / 100_000_000).toFixed(1)} 亿元，平均归母权益 ${(averageEquity / 100_000_000).toFixed(1)} 亿元，滚动 ROE ${roe.toFixed(1)}%。PB 档与 ROE 档取更谨慎结论。`,
  }
}

export function assessInstitutionalTrackCycleValuation(input: {
  marketCapYi: unknown
  incomeRows: FinancialRow[]
  normalizedPeThresholds: ValuationThresholds
}): FinancialValuationResult {
  const marketCapYi = positiveNumber(input.marketCapYi)
  if (marketCapYi === null) return unavailable('缺少有效实时市值。')
  const profits = orderedRows(input.incomeRows).map(quarterlyProfit).filter((value): value is number => value !== null)
  if (profits.length < 12) return unavailable('缺少连续三年单季归母净利润，不能计算中周期盈利。')
  const ttmWindows = [0, 4, 8].map((start) => profits.slice(start, start + 4).reduce((sum, value) => sum + value, 0))
  if (ttmWindows.some((value) => value <= 0)) {
    return { status: 'rated', state: 'income-stagnant', pb: null, ttmProfit: ttmWindows[0], averageEquity: null, roe: null, normalizedPe: null, reason: '最近三组滚动四季利润中存在非正值，不能以低 PE 直接推荐新增。' }
  }
  const ordered = [...ttmWindows].sort((left, right) => left - right)
  const normalizedProfit = ordered[1]
  const normalizedPe = marketCapYi / (normalizedProfit / 100_000_000)
  return {
    status: 'rated', state: lowerIsBetter(normalizedPe, input.normalizedPeThresholds), pb: null, ttmProfit: ttmWindows[0], averageEquity: null, roe: null, normalizedPe,
    reason: `最近三组滚动四季归母净利润为 ${ttmWindows.map((value) => (value / 100_000_000).toFixed(1)).join(' / ')} 亿元；以中位数 ${ (normalizedProfit / 100_000_000).toFixed(1)} 亿元作中周期盈利，归一化 PE ${normalizedPe.toFixed(1)} 倍。`,
  }
}
