import { computed, createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

import buyPointConfigJson from '../../../config/buy-point-analysis.json'
import {
  analyzeBuyPoint,
  buildTradeAdvice,
  type BuyPointAnalysis,
  type BuyPointConfig,
} from '../domain/trade-analysis'

type CompanyTradeSnapshot = {
  code: string
  error?: string
  loading: boolean
  rows?: number[][]
}

const buyPointConfig = buyPointConfigJson as BuyPointConfig

const styles = `
.company-trade-page { color:#29404f; display:grid; gap:1rem; margin:1rem auto 2rem; max-width:1200px; padding:0 .75rem; }
.company-trade-card { background:rgba(255,255,255,.94); border:1px solid rgba(18,58,103,.12); border-radius:1.15rem; box-shadow:0 1rem 2rem rgba(15,23,42,.06); padding:1rem; }
.company-trade-toolbar { align-items:end; display:flex; flex-wrap:wrap; gap:.75rem; justify-content:space-between; }
.company-trade-title { color:#123a67; font-size:1.15rem; font-weight:750; margin:0; }
.company-trade-copy { color:#66788a; font-size:.86rem; line-height:1.55; margin:.3rem 0 0; }
.company-trade-mode { display:flex; flex-wrap:wrap; gap:.45rem; }
.company-trade-mode button { border-radius:999px; }
.company-trade-cost { max-width:12rem; }
.company-trade-hero { border-left:5px solid #64748b; display:grid; gap:.8rem; grid-template-columns:minmax(0,1fr) auto; }
.company-trade-hero.positive { border-left-color:#0f766e; }.company-trade-hero.warning { border-left-color:#d97706; }.company-trade-hero.danger { border-left-color:#dc2626; }
.company-trade-action { color:#123a67; font-size:1.55rem; font-weight:800; line-height:1.2; }
.company-trade-date { color:#66788a; font-size:.8rem; text-align:right; }
.company-trade-score { align-items:center; background:#eef6f5; border-radius:1rem; color:#0f766e; display:flex; font-size:1.1rem; font-weight:800; justify-content:center; min-height:4.3rem; min-width:7rem; padding:.6rem; }
.company-trade-grid { display:grid; gap:1rem; grid-template-columns:repeat(2,minmax(0,1fr)); }
.company-trade-advice { border-radius:.9rem; padding:.9rem; }
.company-trade-advice.active { background:#eef6f5; box-shadow:inset 0 0 0 1px rgba(15,118,110,.18); }
.company-trade-advice h3 { color:#123a67; font-size:1rem; margin:0 0 .4rem; }
.company-trade-advice strong { display:block; font-size:1.08rem; margin-bottom:.25rem; }
.company-trade-levels,.company-trade-scores { display:grid; gap:.7rem; grid-template-columns:repeat(3,minmax(0,1fr)); }
.company-trade-metric { background:#f7fafc; border-radius:.85rem; padding:.75rem; }
.company-trade-metric-label { color:#66788a; font-size:.76rem; margin-bottom:.25rem; }
.company-trade-metric-value { color:#123a67; font-size:1rem; font-weight:750; }
.company-trade-metric-note { color:#66788a; font-size:.75rem; line-height:1.4; margin-top:.25rem; }
.company-trade-evidence-grid { display:grid; gap:.8rem; grid-template-columns:repeat(2,minmax(0,1fr)); }
.company-trade-evidence-group { border:1px solid rgba(18,58,103,.1); border-radius:.9rem; overflow:hidden; }
.company-trade-evidence-group h3 { background:#f2f7fa; color:#123a67; font-size:.94rem; margin:0; padding:.7rem .8rem; }
.company-trade-evidence-item { align-items:flex-start; border-top:1px solid rgba(18,58,103,.08); display:flex; gap:.55rem; justify-content:space-between; padding:.65rem .8rem; }
.company-trade-evidence-item:first-of-type { border-top:0; }
.company-trade-evidence-text { font-size:.82rem; line-height:1.4; }
.company-trade-evidence-value { color:#66788a; font-size:.76rem; white-space:nowrap; }
.company-trade-dot { border-radius:50%; flex:0 0 auto; height:.55rem; margin-top:.28rem; width:.55rem; }
.company-trade-dot.good { background:#0f766e; }.company-trade-dot.bad { background:#dc2626; }.company-trade-dot.off { background:#cbd5e1; }
.company-trade-table { font-size:.85rem; margin:0; }
.company-trade-disclaimer { background:#fff7ed; border-color:#fed7aa; color:#7c2d12; font-size:.82rem; line-height:1.55; }
@media (max-width:767.98px) {
  .company-trade-page { padding:0 .55rem; }.company-trade-grid,.company-trade-evidence-grid { grid-template-columns:1fr; }
  .company-trade-levels,.company-trade-scores { grid-template-columns:1fr; }.company-trade-hero { grid-template-columns:1fr; }.company-trade-date { text-align:left; }
}
`

const CompanyTradePage = defineComponent({
  name: 'CompanyTradePage',
  setup() {
    const snapshot = ref<CompanyTradeSnapshot>({ code: '', loading: true })
    const hasPosition = ref(false)
    const costPriceText = ref('')

    const analysis = computed<BuyPointAnalysis | null>(() => {
      if (!snapshot.value.rows) return null
      try { return analyzeBuyPoint(snapshot.value.rows, buyPointConfig) } catch { return null }
    })
    const costPrice = computed(() => {
      const value = Number(costPriceText.value)
      return Number.isFinite(value) && value > 0 ? value : null
    })
    const advice = computed(() => analysis.value ? buildTradeAdvice(analysis.value, hasPosition.value, costPrice.value) : null)
    const profitPct = computed(() => analysis.value && costPrice.value ? (analysis.value.close / costPrice.value - 1) * 100 : null)

    const onState = (event: Event) => { snapshot.value = (event as CustomEvent<CompanyTradeSnapshot>).detail }
    onMounted(() => {
      window.addEventListener('licai:company-trade-state', onState)
      const existing = (window as typeof window & { __licaiCompanyTradeState?: CompanyTradeSnapshot }).__licaiCompanyTradeState
      if (existing) snapshot.value = existing
    })
    onBeforeUnmount(() => window.removeEventListener('licai:company-trade-state', onState))

    const metric = (label: string, value: string, note?: string) => h('div', { class: 'company-trade-metric' }, [
      h('div', { class: 'company-trade-metric-label' }, label),
      h('div', { class: 'company-trade-metric-value' }, value),
      note ? h('div', { class: 'company-trade-metric-note' }, note) : null,
    ])

    const evidenceItem = (label: string, value: string, active: boolean, risk = false) => h('div', { class: 'company-trade-evidence-item' }, [
      h('span', { class: ['company-trade-dot', active ? risk ? 'bad' : 'good' : 'off'].join(' ') }),
      h('span', { class: 'company-trade-evidence-text flex-grow-1' }, label),
      h('span', { class: 'company-trade-evidence-value' }, value),
    ])

    const evidenceGroup = (title: string, items: ReturnType<typeof evidenceItem>[]) => h('section', { class: 'company-trade-evidence-group' }, [
      h('h3', title), ...items,
    ])

    return () => {
      if (snapshot.value.loading) return h('div', { class: 'company-trade-page' }, [h('style', styles), h('div', { class: 'company-trade-card' }, '正在分析前复权日 K…')])
      if (snapshot.value.error) return h('div', { class: 'company-trade-page' }, [h('style', styles), h('div', { class: 'alert alert-danger' }, snapshot.value.error)])
      const result = analysis.value
      const currentAdvice = advice.value
      if (!result || !currentAdvice) return h('div', { class: 'company-trade-page' }, [h('style', styles), h('div', { class: 'alert alert-warning' }, '有效日 K 不足，暂时无法生成买卖建议。')])
      const { flags, indicators, decline, returns, levels, scores } = result
      return h('div', { class: 'company-trade-page' }, [
        h('style', styles),
        h('section', { class: 'company-trade-card company-trade-toolbar' }, [
          h('div', [h('h1', { class: 'company-trade-title' }, `${snapshot.value.code} 买卖建议`), h('p', { class: 'company-trade-copy' }, '选择你的场景；卖出风险优先于加仓信号，所有价格信号只按收盘确认。')]),
          h('div', { class: 'd-flex flex-wrap gap-2 align-items-end' }, [
            h('div', { class: 'company-trade-mode' }, [
              h('button', { class: ['btn btn-sm', !hasPosition.value ? 'btn-success' : 'btn-outline-success'], onClick: () => { hasPosition.value = false } }, '空仓 / 准备买入'),
              h('button', { class: ['btn btn-sm', hasPosition.value ? 'btn-success' : 'btn-outline-success'], onClick: () => { hasPosition.value = true } }, '已有持仓'),
            ]),
            hasPosition.value ? h('label', { class: 'company-trade-cost' }, [h('span', { class: 'small text-muted' }, '成本价（可选）'), h('input', { class: 'form-control form-control-sm', inputmode: 'decimal', placeholder: '用于区分止盈/止损', value: costPriceText.value, onInput: (event: Event) => { costPriceText.value = (event.target as HTMLInputElement).value } })]) : null,
          ]),
        ]),
        h('section', { class: ['company-trade-card company-trade-hero', currentAdvice.tone].join(' ') }, [
          h('div', [h('div', { class: 'company-trade-action' }, currentAdvice.label), h('p', { class: 'company-trade-copy' }, currentAdvice.summary), profitPct.value !== null ? h('p', { class: 'company-trade-copy' }, `按填写成本计算：${pct(profitPct.value)}`) : null]),
          h('div', [h('div', { class: 'company-trade-score' }, `${scores.total}/100`), h('div', { class: 'company-trade-date mt-2' }, `${result.date} · ${result.bars} 根前复权日 K`)]),
        ]),
        h('section', { class: 'company-trade-card company-trade-grid' }, [
          h('div', { class: ['company-trade-advice', !hasPosition.value ? 'active' : ''].join(' ') }, [h('h3', '买入 / 建仓视角'), h('strong', currentAdvice.buyLabel), h('div', { class: 'company-trade-copy' }, currentAdvice.buySummary)]),
          h('div', { class: ['company-trade-advice', hasPosition.value ? 'active' : ''].join(' ') }, [h('h3', '持仓 / 卖出视角'), h('strong', currentAdvice.holdingLabel), h('div', { class: 'company-trade-copy' }, currentAdvice.holdingSummary)]),
        ]),
        h('section', { class: 'company-trade-card' }, [
          h('h2', { class: 'company-trade-title mb-3' }, '关键执行价位'),
          h('div', { class: 'company-trade-levels' }, [
            metric('支撑观察区', `${price(levels.supportZone[0])} – ${price(levels.supportZone[1])}`, '只说明价格位置，不等于见底。'),
            metric('买入确认触发', price(levels.confirmationTrigger), '后续收盘站上 MA5 与前一日高点的较高值。'),
            metric('参考失效位', price(levels.invalidation), '跌破后停止加仓并重新评估；跳空可能无法按该价成交。'),
          ]),
        ]),
        h('section', { class: 'company-trade-card' }, [
          h('h2', { class: 'company-trade-title mb-3' }, '为什么这样判断'),
          h('div', { class: 'company-trade-evidence-grid' }, [
            evidenceGroup('超跌与位置', [
              evidenceItem('RSI14 进入弱势/超卖区', indicators.rsi14.toFixed(1), flags.rsiWeak),
              evidenceItem('20 日高点回撤达到阈值', pct(decline.drawdown20), flags.moderateDrawdown),
              evidenceItem('近 10 日下跌较密集', `${decline.downDays10} 天下跌`, flags.denseDownDays),
              evidenceItem('价格靠近 20 日支撑', price(result.close), flags.nearSupport),
            ]),
            evidenceGroup('反转确认', [
              evidenceItem('当日阳线且高于前收', flags.bullishDay ? '成立' : '未成立', flags.bullishDay),
              evidenceItem('重新站上 MA5', price(indicators.ma5), flags.reclaimMa5),
              evidenceItem('收盘突破前一日高点', flags.breakPreviousHigh ? '成立' : '未成立', flags.breakPreviousHigh),
              evidenceItem('近 3 日收益转正', pct(returns.day3), flags.positiveShortReturn),
              evidenceItem('上涨伴随量能放大', indicators.volumeRatio === null ? '无数据' : `${indicators.volumeRatio.toFixed(2)} 倍`, flags.volumeExpansion),
            ]),
            evidenceGroup('量能与流动性', [
              evidenceItem('当日量 / 20 日均量', indicators.volumeRatio === null ? '无数据' : `${indicators.volumeRatio.toFixed(2)} 倍`, flags.volumeExpansion),
              evidenceItem('5 日均量 / 20 日均量', indicators.volumeShortRatio === null ? '无数据' : `${indicators.volumeShortRatio.toFixed(2)} 倍`, indicators.volumeShortRatio !== null && indicators.volumeShortRatio >= 1),
              evidenceItem('上涨日 / 下跌日平均量', indicators.upDownVolumeRatio === null ? '无数据' : `${indicators.upDownVolumeRatio.toFixed(2)} 倍`, flags.upVolumeDominant),
              evidenceItem('回调时成交量收缩', flags.volumeContraction ? '缩量' : '未缩量', flags.volumeContraction),
              evidenceItem('放量下跌风险', flags.distributionRisk ? '触发' : '未触发', flags.distributionRisk, true),
              evidenceItem('20 日流动性门槛', flags.lowLiquidity ? '不足' : indicators.liquidityCoverage > 0 ? '通过' : '数据不足', flags.lowLiquidity, true),
            ]),
            evidenceGroup('卖出与风险否决', [
              evidenceItem('跌破此前 20 日最低价', flags.breakdown ? '已破位' : '未破位', flags.breakdown, true),
              evidenceItem('MA20/MA60 空头且 MA20 下行', pct(indicators.ma20SlopePct), flags.fallingTrend, true),
              evidenceItem('ATR 波动率偏高', pct(indicators.atrPct, false), flags.highVolatility, true),
              evidenceItem('反弹或均线乖离偏热', flags.overextended ? '偏热' : '正常', flags.overextended, true),
              evidenceItem('流动性不足', flags.lowLiquidity ? '触发' : '未触发', flags.lowLiquidity, true),
            ]),
          ]),
        ]),
        h('section', { class: 'company-trade-card' }, [
          h('h2', { class: 'company-trade-title mb-3' }, '详细指标'),
          h('div', { class: 'company-trade-scores mb-3' }, [
            metric('位置与缩量条件', String(scores.setup), '跌得多或缩量只进入观察池。'), metric('反转确认', String(scores.confirmation), '价格与量能共同决定是否允许试仓/加仓。'), metric('趋势与风险', `${scores.trend} / -${scores.riskPenalty}`, '破位、放量下跌和低流动性优先。'),
          ]),
          h('div', { class: 'table-responsive' }, [h('table', { class: 'table table-sm table-bordered company-trade-table' }, [
            h('tbody', [
              tableRow('收盘价', price(result.close), '3 / 5 / 10 / 20 日涨跌', `${pct(returns.day3)} / ${pct(returns.day5)} / ${pct(returns.day10)} / ${pct(returns.day20)}`),
              tableRow('近 10 日下跌', `${decline.downDays10} 天，跌日复合 ${pct(decline.downDayReturn10)}`, '连续下跌', `${decline.consecutiveDown} 天，${pct(decline.consecutiveReturn)}`),
              tableRow('20 日回撤', pct(decline.drawdown20), '低点后反弹', `${decline.reboundBars} 日，${pct(decline.rebound20)}`),
              tableRow('MA5 / MA10', `${price(indicators.ma5)} / ${price(indicators.ma10)}`, 'MA20 / MA60', `${price(indicators.ma20)} / ${price(indicators.ma60)}`),
              tableRow('RSI14', indicators.rsi14.toFixed(1), 'ATR14', `${price(indicators.atr14)}（${pct(indicators.atrPct, false)}）`),
              tableRow('MA20 近 5 日斜率', pct(indicators.ma20SlopePct), '当日 / 20 日量比', indicators.volumeRatio === null ? '—' : indicators.volumeRatio.toFixed(2)),
              tableRow('当日成交量', compactNumber(indicators.latestVolume), '5 日 / 20 日均量', `${compactNumber(indicators.volumeMa5)} / ${compactNumber(indicators.volumeMa20)}`),
              tableRow('5 日 / 20 日量比', indicators.volumeShortRatio === null ? '—' : indicators.volumeShortRatio.toFixed(2), '上涨 / 下跌日量比', indicators.upDownVolumeRatio === null ? '—' : indicators.upDownVolumeRatio.toFixed(2)),
              tableRow('当日成交额', compactMoney(indicators.latestAmount), '20 日平均成交额', compactMoney(indicators.amountMa20)),
              tableRow('当日换手率', nullablePct(indicators.latestTurnover), '20 日平均换手率', nullablePct(indicators.turnoverMa20)),
              tableRow('流动性数据覆盖率', pct(indicators.liquidityCoverage * 100, false), '放量下跌 / 缩量回调', `${flags.distributionRisk ? '是' : '否'} / ${flags.volumeContraction ? '是' : '否'}`),
            ]),
          ])]),
        ]),
        h('aside', { class: 'company-trade-card company-trade-disclaimer' }, '这是基于历史价格、成交量、成交额与换手率的规则化技术观察，不预测收益，也不构成个性化投资建议。模型未纳入估值、基本面、公告、盘口深度、交易成本和个人风险承受能力；高波动、涨跌停或跳空时，参考失效位可能无法成交。'),
      ])
    }
  },
})

function tableRow(leftLabel: string, leftValue: string, rightLabel: string, rightValue: string) {
  return h('tr', [h('th', { class: 'table-light' }, leftLabel), h('td', leftValue), h('th', { class: 'table-light' }, rightLabel), h('td', rightValue)])
}
function price(value: number): string { return value >= 100 ? value.toFixed(2) : value >= 10 ? value.toFixed(3) : value.toFixed(4) }
function pct(value: number, signed = true): string { return `${signed && value > 0 ? '+' : ''}${value.toFixed(2)}%` }
function nullablePct(value: number | null): string { return value === null ? '—' : `${value.toFixed(2)}%` }
function compactNumber(value: number | null): string {
  if (value === null) return '—'
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`
  if (value >= 10_000) return `${(value / 10_000).toFixed(2)} 万`
  return value.toFixed(0)
}
function compactMoney(value: number | null): string { return value === null ? '—' : compactNumber(value) }

const root = document.getElementById('company-trade-vue-root')
if (root) createApp(CompanyTradePage).mount(root)
