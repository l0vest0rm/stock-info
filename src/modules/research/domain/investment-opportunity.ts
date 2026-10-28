import type { ValuationAssessment } from '../../../../shared/valuation-assessment';
import type { InvestmentOpportunity, OpportunitySignal, OpportunityMetric, OpportunityGate } from '../../../../shared/investment-opportunity';
import type { KlineBar } from '../../../types';
import type { QuarterlyTtmPoint } from '../../finance/domain/quarterly-ttm-series';

// Injected policy keeps the pure domain runnable in Node and in a Worker.
export type OpportunityPolicy = {
  version: string; historyPercentileMax: number; ttmGrowthMin: number; quarterRevenueGrowthMin: number;
  quarterProfitGrowthMin: number; earningsQuarters: number; cashConversionMin: number; debtRatioReviewAbove: number;
  returns: Record<string, number>; drawdown252Max: number; maxQuoteAgeDays: number; maxFinancialAgeDays: number;
};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const age = (date: string | null | undefined, now: number) => date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? (now - Date.parse(date + 'T00:00:00Z')) / 86400000 : Infinity;
const fresh = (date: string | null | undefined, days: number, now: number) => Number.isFinite(age(date, now)) && age(date, now) >= -1 && age(date, now) <= days;

export function priceOpportunityMetrics(bars: KlineBar[], policy: OpportunityPolicy, now: number): InvestmentOpportunity['price'] {
  const result: InvestmentOpportunity['price'] = { source: 'xueqiu', adjustment: 'qfq', asOf: null, samples: 0, returns: [20, 60, 120].map((sessions) => ({ sessions, value: null })), drawdown252: null, reason: null };
  const rows = [...bars].sort((a, b) => a.date.localeCompare(b.date)).slice(-253);
  result.asOf = rows.at(-1)?.date ?? null;
  result.samples = rows.length;
  if (!rows.length || rows.some((b) => !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || b.source !== 'xueqiu' || !['qfq', 'before'].includes(b.fq) || !positive(b.close)) || new Set(rows.map((r) => r.date)).size !== rows.length) {
    result.reason = '缺少有效雪球前复权价格，或存在缺值/重复日期；不使用未复权跌幅替代。'; return result;
  }
  if (!fresh(result.asOf, policy.maxQuoteAgeDays, now)) { result.reason = '前复权行情日期缺失、过期或未来日期。'; return result; }
  const last = rows.at(-1)!;
  for (const reading of result.returns) {
    const start = rows.at(-1 - reading.sessions);
    // Do not turn a long suspension into an ordinary 20-session return.
    if (start && age(start.date, Date.parse(last.date)) <= reading.sessions * 2.2) reading.value = last.close! / start.close! - 1;
  }
  const window = rows.slice(-252);
  if (window.length === 252 && age(window[0].date, Date.parse(last.date)) <= 550) result.drawdown252 = last.close! / Math.max(...window.map((r) => r.close!)) - 1;
  if (result.returns.some((r) => r.value === null) || result.drawdown252 === null) result.reason = '部分窗口不足或交易日期跨度异常；缺失窗口不按零收益处理。';
  return result;
}

export function buildInvestmentOpportunity(input: {
  assessment: ValuationAssessment | null; archetype: string; blockReasons: string[];
  points: QuarterlyTtmPoint[]; adjustedBars: KlineBar[];
  cashflowTtm: number | null; cashflowReportDate: string | null;
  debtRatio: number | null; balanceReportDate: string | null;
  policy: OpportunityPolicy; now?: number;
}): InvestmentOpportunity {
  const { assessment: a, policy: p } = input;
  const now = input.now ?? Date.now();
  const price = priceOpportunityMetrics(input.adjustedBars, p, now);
  const points = [...input.points].sort((x, y) => y.reportDate.localeCompare(x.reportDate));
  const latest = points[0];
  // Exact preceding calendar quarter; never bridge missing quarters.
  const ends = ['03-31', '06-30', '09-30', '12-31'];
  const index = latest ? ends.indexOf(latest.reportDate.slice(5)) : -1;
  const priorDate = index < 0 ? null : index === 0
    ? String(Number(latest.reportDate.slice(0, 4)) - 1) + '-12-31'
    : latest.reportDate.slice(0, 4) + '-' + ends[index - 1];
  const previous = points.find((q) => q.reportDate === priorDate);
  const qoq = (key: 'quarterRevenue' | 'quarterNetProfit'): number | null => {
    if (!latest || !previous || latest.provisional || previous.provisional || !finite(latest[key]) || !positive(previous[key])) return null;
    const value = latest[key]! / previous[key]! - 1;
    return finite(value) ? value : null;
  };
  const revenueQoQ = qoq('quarterRevenue');
  const profitQoQ = qoq('quarterNetProfit');
  const qoqPeriod = previous && latest ? previous.reportDate + '至' + latest.reportDate : null;
  const qoqReview = revenueQoQ === null || profitQoQ === null
    ? '单季环比缺失或不可比（缺季、非正式披露或上季基数非正）；暂不升级候选。'
    : revenueQoQ < 0 || profitQoQ < 0
      ? '同比线索保留，但单季环比下降；需核查季节性、上年同期环比及一次性因素，暂不升级候选。'
      : null;

  const financial = ['bank', 'insurer', 'broker', 'property_operator'].includes(input.archetype);
  const cyclical = input.archetype === 'cyclical_commodity';
  const twoYearDate = latest ? `${Number(latest.reportDate.slice(0, 4)) - 2}${latest.reportDate.slice(4)}` : '';
  const prior2y = points.find((r) => r.reportDate === twoYearDate);
  const profitCagr2y = positive(latest?.ttmNetProfit) && positive(prior2y?.ttmNetProfit) ? Math.sqrt(latest.ttmNetProfit / prior2y.ttmNetProfit) - 1 : null;
  const cashConversion = !financial && input.cashflowReportDate === latest?.reportDate && finite(input.cashflowTtm) && positive(latest?.ttmNetProfit) ? input.cashflowTtm / latest.ttmNetProfit : null;
  const metric = (key: string, label: string, value: number | null, period: string, source = '已披露财报', unit: 'ratio' | 'multiple' = 'ratio'): OpportunityMetric => ({ key, label, value: finite(value) ? value : null, unit, period, source });
  const history = a?.history.windows ?? [];
  const comparableHistory = !a?.method ? null : a.history.metric === 'PE(TTM)' && a.method.startsWith('PE(TTM)') && !financial && !cyclical;
  const hist3 = history.find((w) => w.years === 3)?.percentile ?? null;
  const hist5 = history.find((w) => w.years === 5)?.percentile ?? null;
  const historySignal: OpportunitySignal = {
    kind: 'historical_discount', group: 'price',
    state: comparableHistory === false ? 'not_applicable' : comparableHistory === null || hist3 === null || hist5 === null ? 'insufficient_data' : hist3 <= p.historyPercentileMax && hist5 <= p.historyPercentileMax ? 'triggered' : 'not_triggered',
    summary: comparableHistory === false ? '当前主方法不适用PE历史折价；不以辅助PE替代行业估值。' : hist3 === null || hist5 === null ? '3年与5年历史窗口尚未同时覆盖。' : `3年分位 ${pct(hist3)}，5年分位 ${pct(hist5)}；双窗口阈值 ${pct(p.historyPercentileMax)}。`,
    metrics: [metric('percentile3y', '3年PE分位', hist3, '3年', '雪球市值＋披露时点财报'), metric('percentile5y', '5年PE分位', hist5, '5年', '雪球市值＋披露时点财报')],
    limitations: ['历史便宜不等于内在低估；需复核增长中枢、竞争力及估值制度是否改变。'],
  };
  const quarters = points.slice(0, p.earningsQuarters);
  const consecutive = quarters.length === p.earningsQuarters && quarters.every((q, i) => !i || (() => { const months = (Number(quarters[i - 1].reportDate.slice(0, 4)) - Number(q.reportDate.slice(0, 4))) * 12 + Number(quarters[i - 1].reportDate.slice(5, 7)) - Number(q.reportDate.slice(5, 7)); return months === 3; })());
  const quarterlyCovered = consecutive && quarters.every((q) => finite(q.revenueYoY) && finite(q.netProfitYoY) && !q.provisional) && finite(a?.operating.ttmGrowth);
  const earningsSignal: OpportunitySignal = {
    kind: 'earnings_delivery', group: 'earnings',
    state: financial || cyclical ? 'not_applicable' : !quarterlyCovered ? 'insufficient_data' : a!.operating.ttmGrowth! >= p.ttmGrowthMin && quarters.every((q) => q.revenueYoY! >= p.quarterRevenueGrowthMin && q.netProfitYoY! >= p.quarterProfitGrowthMin) ? 'triggered' : 'not_triggered',
    summary: financial || cyclical ? '此商业模式需专用正常化盈利/行业指标，不套用通用增长规则。' : !quarterlyCovered ? '缺少连续两个正式单季同比或TTM同比；不将半年报或预告冒充单季。' : `TTM利润同比 ${pct(a!.operating.ttmGrowth!)}；核查连续${p.earningsQuarters}季营收≥${pct(p.quarterRevenueGrowthMin)}、利润≥${pct(p.quarterProfitGrowthMin)}。`,
    metrics: [metric('revenueQoQ', '单季营收环比', revenueQoQ, qoqPeriod ?? '未覆盖'), metric('profitQoQ', '单季利润环比', profitQoQ, qoqPeriod ?? '未覆盖'), ...quarters.flatMap((q) => [metric('revenueYoY-' + q.reportDate, '单季营收同比', q.revenueYoY, q.reportDate), metric('profitYoY-' + q.reportDate, '单季利润同比', q.netProfitYoY, q.reportDate)]), metric('ttmGrowth', 'TTM利润同比', a?.operating.ttmGrowth ?? null, latest?.reportDate ?? '—'), metric('profitCagr2y', 'TTM利润两年复合增长', profitCagr2y, twoYearDate + '至' + (latest?.reportDate ?? '—')), metric('valuation', a?.method ?? '当前估值', a?.current == null ? null : a.unit === 'percent' ? a.current / 100 : a.current, a?.quote?.date ?? '—', a?.quote?.source ?? '—', a?.unit === 'percent' ? 'ratio' : 'multiple')],
    limitations: [qoqReview ?? '最新正式单季营收和利润环比均未下降；未季调，不代表增长加速。', '环比按单季值/上季单季值−1计算；上季非正不计算百分比，累计数和TTM不替代单季。', '增长不是超预期；尚无财报发布前预期快照，不声称价格尚未反映。', '总利润增长不等于摊薄EPS增长；需核查低基数、非经常损益及股本变化。不以PE小于增速判定低估。'],
  };
  const returnsTriggered = price.returns.some((r) => r.value !== null && r.value <= p.returns[String(r.sessions)]);
  const allPriceCovered = price.returns.every((r) => r.value !== null) && price.drawdown252 !== null;
  const drawdownSignal: OpportunitySignal = {
    kind: 'drawdown', group: 'price', state: returnsTriggered || (price.drawdown252 !== null && price.drawdown252 <= p.drawdown252Max) ? 'triggered' : allPriceCovered ? 'not_triggered' : 'insufficient_data',
    summary: '前复权回撤只触发研究，不证明错杀；需对照盈利变化及下跌原因。',
    metrics: [...price.returns.map((r) => metric('return' + r.sessions, `${r.sessions}交易日涨跌`, r.value, `${r.sessions}交易日截至${price.asOf ?? '—'}`, '雪球前复权')), metric('drawdown252', '距252交易日最高收盘价', price.drawdown252, `252交易日截至${price.asOf ?? '—'}`, '雪球前复权')],
    limitations: [price.reason ?? '前复权由数据源处理公司行动；不是经审计的总回报序列。', '行业相对收益、异常波动与同期盈利预测下修尚未覆盖。'],
  };
  const forwardSignal: OpportunitySignal = { kind: 'forward_gap', state: 'insufficient_data', group: 'expectations', summary: '未覆盖：机构预测参考尚未转化为经核验的未来估值情景与当前价格隐含预期。', metrics: [], limitations: ['需预测来源、发布日期、基准EPS、预测期间、币种/稀释口径、增长/利润率/再投资及悲观/基准/乐观情景。', '搜索结果不能直接当作预测事实；接入前保持留空，不用历史增长外推替代。'] };
  const dataErrors = input.blockReasons.filter((r) => !['earnings_shrinking', 'no_available_band', 'no_market_cap_band'].includes(r));
  const dataGate: OpportunityGate = { key: 'data', state: !a || dataErrors.length || !fresh(a.quote?.date, p.maxQuoteAgeDays, now) || !fresh(latest?.reportDate, p.maxFinancialAgeDays, now) ? 'fail' : 'pass', reasons: [] };
  if (dataGate.state === 'fail') dataGate.reasons.push('关键行情/财报缺失、失败、过期或口径不一致，停止升级研究候选。', ...dataErrors);
  else dataGate.reasons.push('行情与最新财报通过基础时效检查；不代表全部质量指标覆盖。');
  const businessGate: OpportunityGate = { key: 'business', state: 'unknown', reasons: [] };
  if (financial || cyclical) businessGate.reasons.push('需要行业专用盈利质量、资本约束或完整周期验证；通用现金利润比不作通过依据。');
  else if (latest?.provisional) businessGate.reasons.push('最新读数含预告/快报，等待正式披露。');
  else if (input.blockReasons.includes('earnings_shrinking') || (finite(a?.operating.ttmGrowth) && a.operating.ttmGrowth < 0) || (cashConversion !== null && cashConversion < 0)) {
    businessGate.state = 'fail'; businessGate.reasons.push('存在利润收缩或经营现金净流出，优先核查风险，不凭便宜升级候选。');
  } else if (cashConversion === null || !finite(a?.operating.ttmGrowth) || profitCagr2y === null || !finite(latest?.revenueYoY) || !finite(input.debtRatio) || !fresh(input.balanceReportDate, p.maxFinancialAgeDays, now)) businessGate.reasons.push('现金转化、两年利润、营收或负债数据未完整覆盖；缺失不视为通过。');
  else if (cashConversion < p.cashConversionMin || profitCagr2y < 0 || latest!.revenueYoY! < 0 || input.debtRatio! > p.debtRatioReviewAbove) businessGate.reasons.push('现金转化、低基数或负债筛查需进一步复核，暂不升级候选。');
  else if (qoqReview) businessGate.reasons.push(qoqReview);
  else { businessGate.state = 'pass'; businessGate.reasons.push('营收、两年利润、同期间现金转化、负债率与最新单季环比通过量化初筛；护城河、扣非及股本稀释仍待人工验证。'); }
  const valuationGate: OpportunityGate = { key: 'valuation', state: !a || a.status === 'unknown' ? 'unknown' : ['undervalued', 'fair_low', 'fair'].includes(a.status) ? 'pass' : 'fail', reasons: [!a || a.status === 'unknown' ? '没有适用且可计算的主方法区间。' : ['undervalued', 'fair_low', 'fair'].includes(a.status) ? '价格未超过现有主方法规则区间上限；这不是公司专属内在价值认证。' : '当前定价高于规则区间；即使触发增长/回撤线索，也不直接升级候选。'] };
  const gates = [dataGate, businessGate, valuationGate];
  const signals = [historySignal, earningsSignal, forwardSignal, drawdownSignal];
  const triggered = signals.some((s) => s.state === 'triggered');
  const stage = dataGate.state === 'fail' ? 'insufficient_data' : businessGate.state === 'fail' ? 'blocked' : triggered ? gates.every((g) => g.state === 'pass') ? 'research_candidate' : 'clue' : signals.filter((s) => s.kind !== 'forward_gap').every((s) => ['not_applicable', 'insufficient_data'].includes(s.state)) ? 'insufficient_data' : 'no_signal';
  return {
    policyVersion: p.version, computedAt: new Date(now).toISOString(), stage, confidence: stage === 'research_candidate' ? 'medium' : 'low', signals, gates, price,
    quality: { revenueQoQ, profitQoQ, qoqPeriod, revenueYoY: latest?.revenueYoY ?? null, profitYoY: latest?.netProfitYoY ?? null, ttmGrowth: a?.operating.ttmGrowth ?? null, profitCagr2y, cashConversion, debtRatio: input.debtRatio, cashflowReportDate: input.cashflowReportDate, balanceReportDate: input.balanceReportDate },
    review: { marketConcern: '尚未核验市场为何给予当前定价；不能从下跌反推利空原因。', alternativeView: triggered ? '已发现可量化线索；经营是否稳定、市场是否过度悲观仍待一手证据验证。' : '目前没有足够证据形成与市场不同的判断。', nextChecks: ['核查下一期正式财报的收入、扣非利润、现金回款和摊薄EPS。', ...(drawdownSignal.state === 'triggered' ? ['核查下跌期间公司公告、行业变化及盈利预测是否同步下修。'] : []), '核查应收/存货、债务到期、资本开支与竞争地位；记录来源和日期。'], invalidation: ['盈利或现金回款持续恶化，或发现一次性收益/稀释主导增长。', '历史估值所依赖的业务结构、资本成本或竞争优势已改变。', '行情/报表过期、币种不一致、关键证据不能复核时撤销候选状态。'] },
    caveats: ['历史折价与回撤都含价格因素；四类线索不按命中数累加评分。', '所有通过均为量化研究初筛，不是买入、换仓或仓位建议。', '阈值是版本化研究政策，尚未证明能预测收益；未做无幸存者偏差的样本外回测。'], future: null, executable: false,
  };
}
