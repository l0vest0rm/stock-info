import { h } from 'vue'
import dailyReviewJson from '../../../../../config/investment-daily-report.json'
import universeJson from '../../../../../config/investment-universe.json'

type Source = { title: string; url: string; publishedAt: string; kind: string }
type DailyAssessment = {
  companyId: string
  action: string
  assessedAt: string
  thesis: string
  expectationDifference: string
  risk: string
  validationNeeded: string
  confidence: string
  sources: Source[]
  valuation?: {
    marketPrice: number
    currency: string
    priceAsOf: string
    conservativeValueLow: number
    conservativeValueHigh: number
  }
}
type DailyReport = {
  status: 'not_reviewed' | 'partial' | 'complete'
  reportDate: string | null
  generatedAt: string | null
  summary: string
  coverage: { checkedCompanyIds: string[]; unavailableCompanyIds: string[]; notes: string }
  materialChanges: Array<{ companyId: string; change: string; eventDate: string; sources: Source[] }>
  assessments: DailyAssessment[]
  rotationComparisons: Array<{ fromCompanyId: string; toCompanyId: string; rationale: string; opportunityCost: string; fundingMarket: string }>
  gaps: string[]
}
const report = dailyReviewJson as DailyReport
const companies = new Map((universeJson as { companies: Array<{ id: string; displayName: string }> }).companies.map(c => [c.id, c.displayName]))
const actionLabels: Record<string,string> = {
  consider_buy: '买入候选·待确认',
  consider_add: '增持候选·待确认',
  research_hold: '持有逻辑复核',
  consider_trim: '减仓风险复核',
  consider_exit: '退出逻辑复核',
  watch: '继续观察',
  insufficient_data: '信息不足',
}
const actionClass: Record<string,string> = {
  consider_buy: 'ivu-opportunity',
  consider_add: 'ivu-opportunity',
  consider_trim: 'ivu-warning',
  consider_exit: 'ivu-warning',
}
const sourceLink = (source: Source) => /^https:\/\//i.test(source.url)
  ? h('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer' }, source.title + ' ↗')
  : h('span', source.title)
export function renderDailyPanel(onSelectCompany: (id: string) => void) {
  const isReviewed = report.status !== 'not_reviewed'
  const checked = report.coverage.checkedCompanyIds.length
  const total = companies.size
  return h('section', { class: 'ivu-daily', id: 'ivu-daily-review', 'aria-labelledby': 'ivu-daily-title' }, [
    h('div', { class: 'ivu-daily-top' }, [
      h('div', [
        h('div', { class: 'ivu-eyebrow' }, 'DAILY RESEARCH REVIEW'),
        h('h2', { id: 'ivu-daily-title' }, '每日研究与策略复盘'),
      ]),
      h('span', { class: 'ivu-daily-status' + (isReviewed ? ' is-reviewed' : '') },
        isReviewed ? (report.reportDate + ' · ' + (report.status === 'complete' ? '全量复盘' : '部分覆盖')) : '尚未开始首轮复盘'),
    ]),
    h('div', { class: 'ivu-daily-metrics' }, [
      h('span', ['证据核对：', h('strong', checked + ' / ' + total + ' 家')]),
      h('span', ['尚未取得来源：', h('strong', String(report.coverage.unavailableCompanyIds.length) + ' 家')]),
      h('span', ['重要变化：', h('strong', String(report.materialChanges.length) + ' 项')]),
      h('span', ['研究判断：', h('strong', String(report.assessments.length) + ' 条')]),
    ]),
    isReviewed
      ? [
          h('p', { class: 'ivu-daily-summary' }, report.summary),
          report.assessments.length
            ? h('div', { class: 'ivu-daily-cards' },
                report.assessments.slice(0, 8).map((a) => h('article', { class: 'ivu-daily-card', key: a.companyId }, [
                  h('div', { class: 'ivu-daily-card-head' }, [
                    h('button', { type: 'button', class: 'ivu-daily-company', onClick: () => onSelectCompany(a.companyId) },
                      companies.get(a.companyId) || a.companyId),
                    h('span', { class: 'ivu-daily-action ' + (actionClass[a.action] || '') }, actionLabels[a.action] || a.action),
                  ]),
                  h('p', a.thesis),
                  h('div', { class: 'ivu-daily-fact' }, '预期差：' + a.expectationDifference),
                  a.valuation ? h('div', { class: 'ivu-daily-fact' },
                    '估值观察：' + a.valuation.marketPrice + ' ' + a.valuation.currency + '（' + a.valuation.priceAsOf + '）；保守价值区间 ' + a.valuation.conservativeValueLow + '–' + a.valuation.conservativeValueHigh) : null,
                  h('div', { class: 'ivu-daily-fact' }, '风险：' + a.risk),
                  h('div', { class: 'ivu-daily-fact' }, '待验证：' + a.validationNeeded),
                  h('div', { class: 'ivu-daily-sources' }, a.sources.slice(0, 3).map(sourceLink)),
                ])))
            : h('p', { class: 'ivu-daily-footnote' }, '本次未产生具备证据支持的个股操作候选；不能据此理解为所有股票都适合买入。'),
          report.materialChanges.length
            ? h('div', { class: 'ivu-daily-updates' }, [
                h('strong', '本轮重要变化'),
                ...report.materialChanges.slice(0, 8).map((c) =>
                  h('p', { key: c.companyId + c.eventDate }, [
                    h('button', { type: 'button', class: 'ivu-daily-company', onClick: () => onSelectCompany(c.companyId) },
                      companies.get(c.companyId) || c.companyId),
                    ' · ' + c.change + '（' + c.eventDate + '） ',
                    ...c.sources.slice(0, 2).map(sourceLink),
                  ])),
              ]) : null,
          report.rotationComparisons.length
            ? h('div', { class: 'ivu-daily-updates' }, [
                h('strong', '候选替换研究（非实际交易指令）'),
                ...report.rotationComparisons.map((r) => h('p', { key: r.fromCompanyId + r.toCompanyId },
                  (companies.get(r.fromCompanyId) || r.fromCompanyId) + ' → ' + (companies.get(r.toCompanyId) || r.toCompanyId) + '：' + r.rationale + '；需验证：' + r.opportunityCost)),
              ]) : null,
          report.gaps.length
            ? h('p', { class: 'ivu-daily-footnote' }, '尚缺资料：' + report.gaps.slice(0, 4).join('；')) : null,
        ]
      : h('p', { class: 'ivu-daily-empty' }, [
          h('strong', '暂无已完成的每日投研结论。'),
          ' 可以按需发起当日复盘：先核对公告、最新财报、行业需求及当日价格，再比较估值和预期差。缺少证据的公司标注信息不足，不会生成伪造的买入或换仓建议。',
        ]),
    h('div', { class: 'ivu-daily-disclaimer' },
      '本站显示公开研究候选观点，不包含你的真实持仓或成本。跨市场换仓需分别核对A股及海外账户资金；是否操作由投资者独立决定。'),
  ])
}
