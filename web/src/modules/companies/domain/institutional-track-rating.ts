export type InstitutionalTrackRatingState = 'buy' | 'overweight' | 'hold' | 'underweight' | 'sell' | 'insufficient'

export type InstitutionalTrackRating = {
  state: InstitutionalTrackRatingState
  label: string
  rationale: string
}

type Input = {
  valuationState: 'deep-value' | 'value' | 'fair' | 'expensive' | 'overvalued' | 'growth-unstable' | 'income-stagnant' | 'unavailable'
  confidence: '高' | '中' | '低'
}

export const institutionalTrackRatingMeta: Record<InstitutionalTrackRatingState, { label: string }> = {
  buy: { label: '买入' },
  overweight: { label: '增持' },
  hold: { label: '持有' },
  underweight: { label: '减持' },
  sell: { label: '卖出' },
  insufficient: { label: '数据不足' },
}

export const institutionalTrackRatingStates = Object.keys(institutionalTrackRatingMeta) as InstitutionalTrackRatingState[]

function rating(state: InstitutionalTrackRatingState, rationale: string): InstitutionalTrackRating {
  return { state, label: institutionalTrackRatingMeta[state].label, rationale }
}

export function assessInstitutionalTrackRating(input: Input): InstitutionalTrackRating {
  if (input.valuationState === 'unavailable' || input.confidence === '低') {
    return rating('insufficient', '当前估值或证据不足，暂不形成评级。')
  }

  switch (input.valuationState) {
    case 'deep-value': return rating('buy', '当前估值处于显著低估区间。')
    case 'value': return rating('overweight', '当前估值偏低，具备相对配置价值。')
    case 'fair': return rating('hold', '当前价格与估值大致匹配，维持持有评级。')
    case 'expensive':
    case 'growth-unstable': return rating('underweight', input.valuationState === 'expensive' ? '当前估值偏高。' : '盈利增长路径尚不稳定。')
    case 'overvalued':
    case 'income-stagnant': return rating('sell', input.valuationState === 'overvalued' ? '当前估值已明显透支。' : '利润停滞，不宜继续持有。')
  }
}
