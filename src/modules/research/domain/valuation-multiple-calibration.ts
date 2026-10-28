/**
 * Comparing hand-set valuation bands against where businesses actually traded.
 *
 * The bands in `finance/domain/valuation-bands.ts` are round numbers chosen by
 * judgement: PE 8–18x for everything that reports earnings, PB 0.8–2.5x for
 * banks.  They are honest defaults, but they are not evidence, and the screen
 * turns them into verdicts.  So it matters whether a given default is anywhere
 * near reality for the group it is applied to.
 *
 * Observed history says it often is not.  Pooling every trading day since 2016
 * across the watchlist (97 codes, Xueqiu daily `pe`/`pb`/`ps`), the share of
 * each archetype's history that the default PE band of 8–18x actually covers is:
 *
 *     insurer                60.3%   the band roughly fits
 *     stable_cash_dividend   42.4%   band sits in the lower tail ⇒ looks dear
 *     bank                   36.4%   band sits in the upper tail ⇒ looks cheap
 *     cyclical_commodity     32.7%
 *     property_operator      28.7%
 *     growth_manufacturing   12.5%
 *     software_platform      11.4%
 *     payment                 6.9%
 *     pre_profit_milestone    4.0%
 *     exchange                0.0%
 *     healthcare_services     0.0%
 *
 * The consequence is structural rather than statistical, and it runs in two
 * directions.  Where the band sits *below* a group's history, a member trading
 * at its own normal level can never look cheap, so that archetype structurally
 * cannot produce a research candidate — 91 of the 97 companies sit in such a
 * group (cyclical 13, exchange 1, growth 30, healthcare 6, payment 2,
 * pre-profit 3, property 2, software 15, stable-dividend 19).  Where the band
 * sits *above* history (banks, 36.4% on PE), the group looks permanently cheap
 * and the screen over-nominates.  All 3 banks do currently screen as
 * `research_candidate`, though via PB rather than PE — the PE band is auxiliary
 * for banks — so the bank case is a caution about the whole default set, not a
 * claim that the PE band alone drives it.
 *
 * Only the 3 insurers (60.3% coverage) sit in a group the PE band describes.
 *
 * This module does not choose new bands.  Calibrating the screen is a decision
 * about strategy — a distribution median includes bubbles and crises, and a low
 * median can mean a permanently de-rated business rather than value — so it
 * belongs to the owner, not to an automated pass.  What this module does is
 * make the gap measurable and impossible to forget:
 *
 * - `summarizeMultipleDistribution` turns a raw daily series into quantiles;
 * - `measureBandCoverage` reports what fraction of observed history the band
 *   covers, and in which direction it is displaced;
 * - `bandExcludesMostHistory` flags a band that covers too little to be
 *   describing the group at all.
 *
 * Read-only, no price, no target, no instruction.
 */

/** Which multiple a band key is measured by, and the column that carries it. */
export const BAND_MULTIPLE_FIELDS: Record<string, { seriesKey: string; label: string }> = {
  pe_ttm: { seriesKey: "peTtm", label: "PE(TTM)" },
  pb: { seriesKey: "pb", label: "PB" },
  ps_ttm: { seriesKey: "ps", label: "PS" },
};

/**
 * Ceiling above which a multiple is treated as a data artefact.
 *
 * A near-zero denominator produces a huge multiple that is not a price
 * observation.  PE above 300x, PB above 50x and PS above 60x are dominated by
 * such artefacts in this dataset, so they are excluded rather than allowed to
 * drag p90 upward and understate how far the band misses.
 */
const MULTIPLE_CEILINGS: Record<string, number> = { peTtm: 300, pb: 50, ps: 60 };

/** Below this share of covered history, the band is not describing the group. */
export const MIN_MEANINGFUL_COVERAGE = 0.25;

export type Quantiles = {
  samples: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
};

/** Linear-interpolated quantile of an already-sorted ascending array. */
export function quantileOfSorted(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (!Number.isFinite(q) || q < 0 || q > 1) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Keep observations that can carry information about a multiple.
 *
 * A negative or nil PE is not "very cheap" — it means the denominator was
 * negative or missing.  Including those would drag the median toward zero and
 * understate where the group actually traded.
 */
export function usableMultipleValues(values: Array<number | null | undefined>, seriesKey: string): number[] {
  const ceiling = MULTIPLE_CEILINGS[seriesKey] ?? 300;
  return values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0 && value <= ceiling,
  );
}

export function sortedUsableValues(values: Array<number | null | undefined>, seriesKey: string): number[] {
  return [...usableMultipleValues(values, seriesKey)].sort((left, right) => left - right);
}

export function summarizeMultipleDistribution(
  values: Array<number | null | undefined>,
  seriesKey: string,
): Quantiles | null {
  const sorted = sortedUsableValues(values, seriesKey);
  if (sorted.length === 0) return null;
  return {
    samples: sorted.length,
    p10: quantileOfSorted(sorted, 0.1)!,
    p25: quantileOfSorted(sorted, 0.25)!,
    median: quantileOfSorted(sorted, 0.5)!,
    p75: quantileOfSorted(sorted, 0.75)!,
    p90: quantileOfSorted(sorted, 0.9)!,
  };
}

/**
 * Which way a band is displaced relative to observed history.
 *
 * - `band_below_history`: most history sits above the band, so a member at its
 *   own normal level reads as expensive (no candidates from this group).
 * - `band_above_history`: most history sits below the band, so a member at its
 *   own normal level reads as cheap (false candidates).
 */
export type BandDisplacement = "band_below_history" | "band_above_history" | "straddles_history";

export type BandCoverage = {
  band: string;
  label: string;
  currentDefault: { low: number; high: number };
  observed: Quantiles;
  /** Fraction of observed daily multiples falling inside [low, high]. */
  shareInsideBand: number;
  displacement: BandDisplacement;
  /** Band midpoint ÷ observed median. >1 means the default is richer than history. */
  midpointVsMedian: number;
  /** The shape disagrees with the band closely enough to be worth acting on. */
  underCoversHistory: boolean;
};

export function measureBandCoverage(
  bandKey: string,
  currentDefault: { low: number; high: number },
  sorted: number[],
): BandCoverage | null {
  const field = BAND_MULTIPLE_FIELDS[bandKey];
  if (!field || sorted.length === 0) return null;
  const observed = summarizeMultipleDistribution(sorted, field.seriesKey);
  if (!observed) return null;

  // sorted is ascending, so the count inside the band is a contiguous slice.
  const firstInside = lowerBound(sorted, currentDefault.low);
  const firstAbove = upperBound(sorted, currentDefault.high);
  const shareInsideBand = (firstAbove - firstInside) / sorted.length;

  const midpoint = (currentDefault.low + currentDefault.high) / 2;
  const displacement: BandDisplacement =
    observed.median > currentDefault.high
      ? "band_below_history"
      : observed.median < currentDefault.low
        ? "band_above_history"
        : "straddles_history";

  return {
    band: bandKey,
    label: field.label,
    currentDefault,
    observed,
    shareInsideBand,
    displacement,
    midpointVsMedian: observed.median > 0 ? midpoint / observed.median : Number.NaN,
    underCoversHistory: shareInsideBand < MIN_MEANINGFUL_COVERAGE,
  };
}

/** A band that covers less than a quarter of observed history is not describing the group. */
export function bandExcludesMostHistory(coverage: BandCoverage): boolean {
  return coverage.shareInsideBand < MIN_MEANINGFUL_COVERAGE;
}

/** First index whose value is >= target (ascending input). */
function lowerBound(sorted: number[], target: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** First index whose value is > target (ascending input). */
function upperBound(sorted: number[], target: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid] <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}
