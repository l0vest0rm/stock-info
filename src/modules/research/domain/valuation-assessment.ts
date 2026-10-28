import type { FinancialStatement, KlineBar } from '../../../types';
import type { ValuationBandReadModel } from '../../finance/domain/valuation-bands';
import type { QuarterlySeriesReadModel } from '../../finance/domain/quarterly-ttm-series';
import type { ValuationScreenResult } from './valuation-screen';
import { buildPointInTimePeSeries, noticeDateOf } from './point-in-time-pe.ts';
import { isCumulativeIncomeRow } from '../../finance/domain/income-row-contracts.ts';

import type { ValuationAssessment } from '../../../../shared/valuation-assessment';
export type { ValuationAssessment } from '../../../../shared/valuation-assessment';

/** Explicit policy bands, not a fitted probability or an intrinsic-value claim. */
export function bandPosition(cap: number, low: number, high: number): ValuationAssessment['status'] {
  if (![cap, low, high].every((v) => Number.isFinite(v) && v > 0) || low > high) return 'unknown';
  if (cap < low) return 'undervalued';
  if (cap < (low + high) / 2) return 'fair_low';
  if (cap <= high) return 'fair';
  return cap <= high * 1.2 ? 'expensive' : 'very_expensive';
}

export function assessValuation(input: {
  result: ValuationScreenResult;
  bands: ValuationBandReadModel;
  series: QuarterlySeriesReadModel;
  statements: FinancialStatement[];
  bars: KlineBar[];
  quote: ValuationAssessment['quote'];
  historyComparable: boolean;
}): ValuationAssessment {
  const { result, bands, series, quote } = input;
  const chosen = bands.bands.find((b) => b.key === result.basis?.key);
  const cap = result.position?.marketCap;
  const range = chosen?.range ?? null;
  const denominator = chosen?.denominator?.value;
  const eligible = result.verdict !== 'blocked' && chosen?.role === 'primary' && range && denominator && denominator > 0 && cap && cap > 0;
  const low = eligible ? chosen.unit === 'percent' ? denominator * 100 / range.high : denominator * range.low : null;
  const high = eligible ? chosen.unit === 'percent' ? denominator * 100 / range.low : denominator * range.high : null;
  const status = low && high && cap ? bandPosition(cap, low, high) : 'unknown';
  const latest = series.points[0];
  const limitations = [...bands.warnings.filter((warning) => !cap || !warning.startsWith('未提供市值')),  '区间来自现有行业/商业模式规则，尚非公司专属内在价值；未来估值未覆盖。'];
  if (!eligible) limitations.push(result.note);
  if (chosen?.role === 'auxiliary') limitations.push('仅有辅助方法，不据此判定低估或合理。');
  if (latest?.provisional) limitations.push('最新经营读数包含业绩预告/快报，非正式财报。');
  const current = cap && denominator && denominator > 0 ? chosen?.unit === 'percent' ? denominator / cap * 100 : cap / denominator : null;
  // No guessed announcement dates, no quarterized rows, no provider backfilled PE.
  const strictRows = input.statements.filter((r) => noticeDateOf(r) && isCumulativeIncomeRow((r.payload ?? {}) as Record<string, unknown>));
  const historical = input.historyComparable && chosen?.key === 'pe_ttm'
    ? buildPointInTimePeSeries(strictRows, input.bars.filter((b) => b.marketCapital && b.marketCapital > 0).map((b) => ({ date: b.date, marketCap: b.marketCapital! })), { ceiling: Infinity }).map((p) => ({ date: p.date, value: p.peTtm }))
    : [];
  const historyEnd = quote?.date;
  const windows = [3, 5].map((years) => {
    const from = historyEnd ? `${Number(historyEnd.slice(0, 4)) - years}${historyEnd.slice(4)}` : '';
    const values = historical.filter((p) => p.date >= from && p.date <= (historyEnd ?? '') && p.value !== null && Number.isFinite(p.value));
    const span = values.length > 1 ? (Date.parse(values.at(-1)!.date) - Date.parse(values[0].date)) / 86400000 : 0;
    const enough = values.length >= years * 180 && span >= years * 365 * 0.85;
    return { years, percentile: enough && current !== null ? values.filter((p) => p.value! <= current).length / values.length : null, samples: values.length, from: values[0]?.date ?? null, to: values.at(-1)?.date ?? null };
  });
  return {
    status, confidence: eligible && result.growth?.verdict !== 'unknown' && !latest?.provisional ? 'medium' : 'low',
    method: chosen?.label ?? null, current, unit: chosen?.unit ?? null, range,
    conservativeMargin: low && cap ? 1 - cap / low : null,
    assumptions: chosen?.assumptions ?? [], limitations, quote,
    history: { metric: 'PE(TTM)', windows, note: '只用披露日已知的累计财报重建PE；缺披露日、币种不可比或样本不足时留空。历史分位不等于低估；历史重述仍可能影响结果。非PE主方法暂不提供分位。' },
    operating: { reportDate: latest?.reportDate ?? null, periodLabel: latest?.quarterNetProfit != null ? '最近单季' : '最近报告期（无单季口径）', revenueYoY: latest?.revenueYoY ?? null, profitYoY: latest?.netProfitYoY ?? null, ttmGrowth: result.growth?.ttmGrowth ?? null, provisional: latest?.provisional ?? false },
    future: null, computedAt: new Date().toISOString(),
  };
}
