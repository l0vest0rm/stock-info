import type { MacroObservationVintage } from "./model";

export type DatedValue = { date: string; value: number };

/**
 * Builds a conservative point-in-time series for backtests. Only the first
 * stored vintage of each statistical period is used, and the signal is dated
 * when that vintage became available to this system. Historical backfills are
 * therefore not treated as if they had been known on their observation dates.
 */
export function initialReleasePoints(
  observations: readonly MacroObservationVintage[]
): DatedValue[] {
  const initialByPeriod = new Map<string, MacroObservationVintage>();
  for (const item of observations) {
    if (item.qualityStatus !== "valid") continue;
    const current = initialByPeriod.get(item.observationDate);
    if (!current || item.vintageAt < current.vintageAt) initialByPeriod.set(item.observationDate, item);
  }
  return [...initialByPeriod.values()]
    .sort((left, right) => left.observationDate.localeCompare(right.observationDate))
    .map((item) => ({
      date: new Date(Math.max(item.releasedAt, item.vintageAt)).toISOString().slice(0, 10),
      value: item.value,
    }));
}

export type FactorExposure = {
  market: string;
  factor: string;
  signal: number;
  weight: number;
  direction?: 1 | -1;
};

export type MarketFactorResult = {
  market: string;
  score: number | null;
  contributions: Array<{ factor: string; contribution: number; signal: number; weight: number }>;
};

export function calculateMarketFactorContributions(exposures: readonly FactorExposure[]): MarketFactorResult[] {
  const markets = new Map<string, FactorExposure[]>();
  for (const exposure of exposures) {
    if (!Number.isFinite(exposure.signal) || !Number.isFinite(exposure.weight)) continue;
    const group = markets.get(exposure.market) ?? [];
    group.push(exposure);
    markets.set(exposure.market, group);
  }
  return [...markets].map(([market, items]) => {
    const contributions = items.map((item) => ({
      factor: item.factor,
      contribution: item.signal * item.weight * (item.direction ?? 1),
      signal: item.signal,
      weight: item.weight,
    })).sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution));
    const denominator = items.reduce((sum, item) => sum + Math.abs(item.weight), 0);
    return {
      market,
      score: denominator === 0 ? null : contributions.reduce((sum, item) => sum + item.contribution, 0) / denominator,
      contributions,
    };
  }).sort((left, right) => left.market.localeCompare(right.market));
}

export function rollingCorrelation(
  left: readonly DatedValue[],
  right: readonly DatedValue[],
  window: number
): Array<{ date: string; value: number | null; observations: number }> {
  const rightByDate = new Map(right.filter(validPoint).map((point) => [point.date, point.value]));
  const aligned = left.filter(validPoint).filter((point) => rightByDate.has(point.date))
    .map((point) => ({ date: point.date, left: point.value, right: rightByDate.get(point.date)! }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const size = Math.max(2, Math.floor(window));
  return aligned.map((point, index) => {
    const sample = aligned.slice(Math.max(0, index - size + 1), index + 1);
    return {
      date: point.date,
      value: sample.length < size ? null : pearson(sample.map((item) => item.left), sample.map((item) => item.right)),
      observations: sample.length,
    };
  });
}

export type BacktestCondition = { operator: "gte" | "lte"; threshold: number };
export type BacktestTrade = { signalDate: string; entryDate: string; exitDate: string; signal: number; returnPct: number };

export function backtestSignal(
  signals: readonly DatedValue[],
  marketPrices: readonly DatedValue[],
  condition: BacktestCondition,
  horizonPeriods: number
): {
  trades: BacktestTrade[];
  averageReturnPct: number | null;
  medianReturnPct: number | null;
  winRatePct: number | null;
} {
  const prices = marketPrices.filter(validPoint).filter((point) => point.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const horizon = Math.max(1, Math.floor(horizonPeriods));
  const trades: BacktestTrade[] = [];
  const firstPriceDate = prices[0]?.date;
  for (const signal of signals.filter(validPoint).sort((a, b) => a.date.localeCompare(b.date))) {
    if (!firstPriceDate || signal.date < firstPriceDate) continue;
    const triggered = condition.operator === "gte" ? signal.value >= condition.threshold : signal.value <= condition.threshold;
    if (!triggered) continue;
    // Enter only on the first price strictly after the signal date to avoid look-ahead bias.
    const entryIndex = prices.findIndex((price) => price.date > signal.date);
    const exitIndex = entryIndex + horizon;
    if (entryIndex < 0 || exitIndex >= prices.length) continue;
    const entry = prices[entryIndex];
    const exit = prices[exitIndex];
    trades.push({
      signalDate: signal.date,
      entryDate: entry.date,
      exitDate: exit.date,
      signal: signal.value,
      returnPct: ((exit.value / entry.value) - 1) * 100,
    });
  }
  const returns = trades.map((trade) => trade.returnPct);
  return {
    trades,
    averageReturnPct: returns.length ? average(returns) : null,
    medianReturnPct: returns.length ? median(returns) : null,
    winRatePct: returns.length ? (returns.filter((value) => value > 0).length / returns.length) * 100 : null,
  };
}

export function replayScenario(
  seriesById: Readonly<Record<string, readonly DatedValue[]>>,
  from: string,
  to: string
): Array<{ seriesId: string; start: DatedValue; end: DatedValue; change: number; changePct: number | null }> {
  return Object.entries(seriesById).flatMap(([seriesId, input]) => {
    const points = input.filter(validPoint).filter((point) => point.date >= from && point.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date));
    const start = points[0];
    const end = points.at(-1);
    if (!start || !end) return [];
    return [{
      seriesId,
      start,
      end,
      change: end.value - start.value,
      changePct: start.value === 0 ? null : ((end.value / start.value) - 1) * 100,
    }];
  });
}

function pearson(left: number[], right: number[]): number | null {
  const leftMean = average(left);
  const rightMean = average(right);
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator === 0 ? null : covariance / denominator;
}

function validPoint(point: DatedValue): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.value);
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
