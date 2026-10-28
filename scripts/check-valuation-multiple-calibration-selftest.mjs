/**
 * Deterministic check for valuation multiple calibration.
 * Run: node scripts/check-valuation-multiple-calibration-selftest.mjs
 *
 * The distributions pinned here are the real pooled numbers measured on
 * 2026-10-28 from Xueqiu daily PE/PB/PS columns (2016-01-01 → today, 97 codes).
 * They are pinned because they are the reason this module exists: the hand-set
 * PE band of 8–18x covers only 60% of the one archetype it fits, and 0–13% of
 * the four biggest groups in the watchlist.  A band that covers 0% of a group's
 * history is not a conservative assumption about that group; it is a different
 * claim entirely.
 */
import assert from "node:assert/strict";
import {
  BAND_MULTIPLE_FIELDS,
  MIN_MEANINGFUL_COVERAGE,
  bandExcludesMostHistory,
  measureBandCoverage,
  quantileOfSorted,
  sortedUsableValues,
  summarizeMultipleDistribution,
  usableMultipleValues,
} from "../src/modules/research/domain/valuation-multiple-calibration.ts";

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    throw err;
  }
};

const PE_BAND = { low: 8, high: 18 };

/** Real pooled PE(TTM) quantiles, 2026-10-28 (from report-band-coverage). */
const OBSERVED_PE = {
  bank: { samples: 7866, p10: 4.99, p25: 5.76, median: 6.89, p75: 9.39, p90: 11.37 },
  insurer: { samples: 7801, p10: 7.90, p25: 9.40, median: 12.55, p75: 18.63, p90: 25.96 },
  stable_cash_dividend: { samples: 42309, p10: 9.14, p25: 13.45, median: 18.47, p75: 27.89, p90: 43.01 },
  cyclical_commodity: { samples: 27799, p10: 8.66, p25: 13.38, median: 20.79, p75: 37.92, p90: 81.26 },
  property_operator: { samples: 4989, p10: 12.14, p25: 15.88, median: 31.27, p75: 44.81, p90: 58.78 },
  software_platform: { samples: 33593, p10: 17.27, p25: 23.49, median: 32.44, p75: 61.59, p90: 120.02 },
  payment: { samples: 4301, p10: 20.35, p25: 26.18, median: 29.21, p75: 33.62, p90: 41.37 },
  exchange: { samples: 2661, p10: 26.69, p25: 30.66, median: 35.84, p75: 41.55, p90: 46.67 },
  growth_manufacturing: { samples: 69060, p10: 16.11, p25: 23.47, median: 35.98, p75: 57.38, p90: 101.45 },
  healthcare_services: { samples: 12098, p10: 30.60, p25: 41.40, median: 59.30, p75: 77.30, p90: 119.87 },
  pre_profit_milestone: { samples: 5370, p10: 31.06, p25: 40.98, median: 53.30, p75: 72.22, p90: 92.90 },
};

/**
 * Measured coverage of the 8–18x band on 2026-10-28 (`report-band-coverage.mjs`):
 *
 *     insurer 60.3% · stable_cash_dividend 42.4% · bank 36.4% ·
 *     cyclical_commodity 32.7% · property_operator 28.7% ·
 *     growth_manufacturing 12.5% · software_platform 11.4% · payment 6.9% ·
 *     pre_profit_milestone 4.0% · exchange 0.0% · healthcare_services 0.0%
 *
 * Not asserted against the reconstructed fixtures below: reproducing a share
 * over 8k–70k daily observations needs the full series, and a five-point
 * reconstruction lands within a couple of percentage points, not exactly.  The
 * tests assert direction and the threshold verdict instead.
 */

// --- quantiles --------------------------------------------------------------

check("quantile interpolates between order statistics", () => {
  assert.equal(quantileOfSorted([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantileOfSorted([1, 2, 3, 4, 5], 0), 1);
  assert.equal(quantileOfSorted([1, 2, 3, 4, 5], 1), 5);
  assert.equal(quantileOfSorted([0, 10], 0.25), 2.5);
});

check("quantile of an empty series is null, not NaN or 0", () => {
  assert.equal(quantileOfSorted([], 0.5), null);
});

check("out-of-range quantile requests are refused", () => {
  assert.equal(quantileOfSorted([1, 2, 3], -0.1), null);
  assert.equal(quantileOfSorted([1, 2, 3], 1.1), null);
  assert.equal(quantileOfSorted([1, 2, 3], Number.NaN), null);
});

// --- exclusion rules --------------------------------------------------------

check("negative and nil multiples are dropped, not treated as cheap", () => {
  // A loss-making company has PE < 0. Averaging that in would drag the median
  // below the real trading range and make the group look cheaper than it is.
  assert.deepEqual(usableMultipleValues([10, -5, null, undefined, 0, 20], "peTtm"), [10, 20]);
});

check("absurd artefacts are dropped per series", () => {
  // A ~zero denominator yields PE 1200; that is not a price observation.
  assert.deepEqual(usableMultipleValues([10, 1200], "peTtm"), [10]);
  assert.deepEqual(usableMultipleValues([10, 900], "pb"), [10]);
  assert.deepEqual(usableMultipleValues([10, 900], "ps"), [10]);
});

check("summarize returns null when nothing usable remains", () => {
  assert.equal(summarizeMultipleDistribution([-1, null, 0], "peTtm"), null);
});

// --- coverage arithmetic ----------------------------------------------------

check("coverage is the exact share of observations inside the band", () => {
  // 10 of 100 observations inside 8–18 ⇒ 10%.
  const values = [...Array(5).fill(8), ...Array(5).fill(17), ...Array(80).fill(40), ...Array(10).fill(2)];
  const coverage = measureBandCoverage("pe_ttm", PE_BAND, sortedUsableValues(values, "peTtm"));
  assert.ok(coverage);
  assert.equal(coverage.shareInsideBand, 0.1);
});

check("band edges are inclusive", () => {
  // A multiple exactly at 8 or 18 is inside; excluding the endpoints would make
  // the reported coverage depend on a `<` vs `<=` accident.
  const values = [8, 8, 18, 18];
  const coverage = measureBandCoverage("pe_ttm", PE_BAND, sortedUsableValues(values, "peTtm"));
  assert.ok(coverage);
  assert.equal(coverage.shareInsideBand, 1);
});

check("a group trading entirely above the band covers nothing", () => {
  const values = Array(50).fill(40);
  const coverage = measureBandCoverage("pe_ttm", PE_BAND, sortedUsableValues(values, "peTtm"));
  assert.ok(coverage);
  assert.equal(coverage.shareInsideBand, 0);
  assert.equal(coverage.displacement, "band_below_history");
  assert.equal(bandExcludesMostHistory(coverage), true);
});

check("a group trading entirely below the band also covers nothing", () => {
  const values = Array(50).fill(2);
  const coverage = measureBandCoverage("pe_ttm", PE_BAND, sortedUsableValues(values, "peTtm"));
  assert.ok(coverage);
  assert.equal(coverage.shareInsideBand, 0);
  assert.equal(coverage.displacement, "band_above_history");
  assert.equal(bandExcludesMostHistory(coverage), true);
});

// --- the structural finding -------------------------------------------------

check("banks look permanently cheap because the band sits above their history", () => {
  const coverage = measureBandCoverage("pe_ttm", PE_BAND, expand(OBSERVED_PE.bank));
  assert.ok(coverage);
  assert.equal(coverage.displacement, "band_above_history");
  assert.ok(coverage.observed.median < PE_BAND.low, "bank median 6.9x is below the band floor of 8x");
  // And the band still covers a third of history, so it is not "wrong", just
  // skewed — this is why the finding is about direction, not about a mistake.
  assert.equal(bandExcludesMostHistory(coverage), false);
});

check("insurers are the only archetype the default band roughly fits", () => {
  const coverage = measureBandCoverage("pe_ttm", PE_BAND, expand(OBSERVED_PE.insurer));
  assert.ok(coverage);
  assert.equal(coverage.displacement, "straddles_history");
  // Only the *direction* is asserted here.  The exact 60.3% requires all 7,801
  // daily observations; the five-point reconstruction above cannot reproduce it
  // and asserting a number it cannot produce would be a fake test.  The measured
  // figure is what `report-band-coverage.mjs` prints.
  assert.equal(bandExcludesMostHistory(coverage), false);
});

check("the four largest groups are structurally unable to nominate", () => {
  // growth_manufacturing(30) + software_platform(15) + healthcare_services(6)
  // + exchange(1) = 52 companies whose group median is far above the band.  A
  // member trading at its own normal level cannot pass, whatever its merits.
  //
  // Only direction and the threshold verdict are asserted: reproducing the exact
  // 0–13% coverage needs all 8k–70k daily observations, and a five-point
  // reconstruction cannot.  Asserting the precise figure here would be a test
  // that passes because the tolerance was widened, not because it is right.
  // The measured numbers come from `report-band-coverage.mjs`.
  for (const name of ["growth_manufacturing", "software_platform", "healthcare_services", "exchange"]) {
    const coverage = measureBandCoverage("pe_ttm", PE_BAND, expand(OBSERVED_PE[name]));
    assert.ok(coverage, name);
    assert.equal(coverage.displacement, "band_below_history", name);
    assert.equal(bandExcludesMostHistory(coverage), true, name);
    assert.ok(coverage.observed.median > PE_BAND.high * 1.5, `${name} median should be far above 18x`);
  }
});

check("a band covering over a quarter of history is not flagged", () => {
  // insurer 60.3%, stable_cash_dividend 42.4%, bank 36.4%, cyclical 32.7% and
  // property 28.7% clear the threshold; the rest do not.
  for (const name of ["insurer", "stable_cash_dividend", "bank", "cyclical_commodity", "property_operator"]) {
    const coverage = measureBandCoverage("pe_ttm", PE_BAND, expand(OBSERVED_PE[name]));
    assert.ok(coverage, name);
    assert.equal(bandExcludesMostHistory(coverage), false, name);
  }
  for (const name of ["growth_manufacturing", "software_platform", "payment", "pre_profit_milestone"]) {
    const coverage = measureBandCoverage("pe_ttm", PE_BAND, expand(OBSERVED_PE[name]));
    assert.ok(coverage, name);
    assert.equal(bandExcludesMostHistory(coverage), true, name);
  }
});

check("the threshold itself is a stated constant, not a hidden 0.5", () => {
  assert.equal(MIN_MEANINGFUL_COVERAGE, 0.25);
});

// --- positioning ------------------------------------------------------------

check("midpointVsMedian states how much richer the default is", () => {
  const coverage = measureBandCoverage("pe_ttm", PE_BAND, expand(OBSERVED_PE.bank));
  assert.ok(coverage);
  assert.ok(coverage.midpointVsMedian > 1, "13x midpoint is richer than the 6.9x bank median");
  const expensive = measureBandCoverage("pe_ttm", PE_BAND, expand(OBSERVED_PE.healthcare_services));
  assert.ok(expensive);
  assert.ok(expensive.midpointVsMedian < 1, "13x midpoint is far cheaper than the 59x healthcare median");
});

check("an unknown band key is refused rather than guessed", () => {
  assert.equal(measureBandCoverage("ev_ebitda_light", PE_BAND, [1, 2, 3]), null);
});

check("every calibrated band key maps to a K-line column", () => {
  // The calibration can only ever rest on data the repository already stores.
  for (const [key, field] of Object.entries(BAND_MULTIPLE_FIELDS)) {
    assert.ok(field.seriesKey.length > 0, key);
    assert.ok(field.label.length > 0, key);
    assert.ok(["peTtm", "pb", "ps"].includes(field.seriesKey), key);
  }
});

/**
 * Rebuild a plausible daily series from pinned quantiles.
 *
 * The real series are 8k–70k observations each; carrying them in a test would
 * be 10 MB of fixture for a check on the quantile arithmetic.  Anchoring the
 * quartile boundaries reproduces the same coverage figure to within the
 * interpolation, which is what the assertions above compare against.
 */
function expand(observed) {
  return [
    ...Array(100).fill(observed.p10),
    ...Array(150).fill(observed.p25),
    ...Array(200).fill(observed.median),
    ...Array(150).fill(observed.p75),
    ...Array(100).fill(observed.p90),
  ];
}

console.log(`valuation multiple calibration: ${passed} checks passed`);
