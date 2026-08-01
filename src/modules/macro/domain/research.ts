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
  /** Stable configured identifier; exposed so clients can audit data quality. */
  seriesId?: string;
  signal?: number | null;
  weight: number;
  direction?: 1 | -1;
  quality?: "fresh" | "stale" | "missing";
  /**
   * Fresh data has a weight of 1. Stale data is supplied by the API as a
   * bounded age-based decay; missing or unusable signals always receive 0.
   */
  freshnessWeight?: number;
};

export type SignalCoverage = {
  configured: number;
  available: number;
  fresh: number;
  stale: number;
  missing: number;
  configuredWeight: number;
  availableWeight: number;
  effectiveWeight: number;
};

export type MarketFactorResult = {
  market: string;
  score: number | null;
  /** 0..1, the effective configured exposure weight supported by usable data. */
  confidence: number;
  confidenceLevel: "high" | "medium" | "low" | "unavailable";
  coverage: SignalCoverage;
  contributions: Array<{
    factor: string;
    seriesId?: string;
    contribution: number;
    signal: number | null;
    weight: number;
    quality: "fresh" | "stale" | "missing";
    freshnessWeight: number;
  }>;
};

export function calculateMarketFactorContributions(exposures: readonly FactorExposure[]): MarketFactorResult[] {
  const markets = new Map<string, FactorExposure[]>();
  for (const exposure of exposures) {
    if (!Number.isFinite(exposure.weight)) continue;
    const group = markets.get(exposure.market) ?? [];
    group.push(exposure);
    markets.set(exposure.market, group);
  }
  return [...markets].map(([market, items]) => {
    const contributions = items.map((item) => {
      const signal = Number.isFinite(item.signal) ? item.signal! : null;
      const quality = signal === null ? "missing" : item.quality ?? "fresh";
      const freshnessWeight = quality === "fresh"
        ? 1
        : quality === "stale"
          ? boundedWeight(item.freshnessWeight ?? 0.5)
          : 0;
      return {
        factor: item.factor,
        ...(item.seriesId ? { seriesId: item.seriesId } : {}),
        contribution: signal === null ? 0 : signal * item.weight * (item.direction ?? 1) * freshnessWeight,
        signal,
        weight: item.weight,
        quality,
        freshnessWeight,
      };
    }).sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution));
    const configuredWeight = items.reduce((sum, item) => sum + Math.abs(item.weight), 0);
    const available = contributions.filter((item) => item.signal !== null);
    const effectiveWeight = contributions.reduce((sum, item) => sum + Math.abs(item.weight) * item.freshnessWeight, 0);
    const confidence = configuredWeight === 0 ? 0 : effectiveWeight / configuredWeight;
    const confidenceLevel: MarketFactorResult["confidenceLevel"] = confidence >= 0.85 ? "high" : confidence >= 0.6 ? "medium" : confidence > 0 ? "low" : "unavailable";
    const coverage: SignalCoverage = {
      configured: items.length,
      available: available.length,
      fresh: contributions.filter((item) => item.quality === "fresh").length,
      stale: contributions.filter((item) => item.quality === "stale").length,
      missing: contributions.filter((item) => item.quality === "missing").length,
      configuredWeight,
      availableWeight: available.reduce((sum, item) => sum + Math.abs(item.weight), 0),
      effectiveWeight,
    };
    return {
      market,
      // Divide by the configured exposure, rather than only the available
      // exposure, so stale/missing inputs cannot create a full-strength score.
      score: configuredWeight === 0 || coverage.available === 0 ? null : contributions.reduce((sum, item) => sum + item.contribution, 0) / configuredWeight,
      confidence,
      confidenceLevel,
      coverage,
      contributions,
    };
  }).sort((left, right) => left.market.localeCompare(right.market));
}

function boundedWeight(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
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
