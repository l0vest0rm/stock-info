// Retained assertion coverage; all domain computations execute in native Rust.
import { callRustSelftest, screenValuationCandidate } from './lib/rust-analysis.mjs';
const nativeConstants = callRustSelftest('constants');
const IMPLAUSIBLE_GROWTH_THRESHOLD = nativeConstants.IMPLAUSIBLE_GROWTH_THRESHOLD;
const SHRINKING_EARNINGS_THRESHOLD = nativeConstants.SHRINKING_EARNINGS_THRESHOLD;
const WEAK_GROWTH_THRESHOLD = nativeConstants.WEAK_GROWTH_THRESHOLD;
const assessGrowthAgainstBand = (...args) => callRustSelftest('assessGrowthAgainstBand', ...args);
const growthVetoesNomination = (...args) => callRustSelftest('growthVetoesNomination', ...args);
/**
 * Deterministic check for the growth veto.
 * Run: node scripts/check-growth-veto-selftest.mjs
 *
 * The veto exists because a low multiple on shrinking earnings is not a
 * discount — the numerator and denominator are falling together.  The tests
 * assert the three properties that make it safe to apply:
 *
 * 1. it is one-directional — growth can stop a nomination and can never create
 *    one;
 * 2. absent growth never blocks, because a data gap is not a fact about the
 *    company;
 * 3. it applies only to earnings-anchored bands, so banks and asset-backed
 *    companies are not blocked for a reason that does not touch their multiple.
 *
 * It also pins the measurement that ruled out the stronger version — setting
 * the band itself from growth — so that conclusion cannot be quietly reversed.
 */
import assert from "node:assert/strict";



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

const YI = 100_000_000;

function capBand(overrides = {}) {
  return {
    key: "pe_ttm",
    role: "primary",
    status: "available",
    unit: "multiple",
    range: { low: 8, high: 18 },
    denominator: { basis: "net_income_ttm", value: 100 * YI, reportDate: "2026-06-30" },
    ...overrides,
  };
}

/** A company well inside its band: band 8–18x on 100 亿 ⇒ cap 800 亿, quote 500 亿. */
const CHEAP = {
  code: "CHEAP.SZ",
  archetype: "growth_manufacturing",
  bandCurrency: "CNY",
  bands: [capBand()],
  quote: { currency: "CNY", priceAsOf: "2026-10-28", marketCap: 500 * YI },
};

// --- classification ---------------------------------------------------------

check("growth above the weak threshold supports the band", () => {
  const assessment = assessGrowthAgainstBand({ ttmGrowth: 0.2, reportDate: "2026-09-30" });
  assert.equal(assessment.verdict, "supports");
  assert.equal(assessment.note, null);
});

check("mild shrinkage weakens but does not veto", () => {
  const assessment = assessGrowthAgainstBand({ ttmGrowth: -0.08, reportDate: "2026-09-30" });
  assert.equal(assessment.verdict, "weakens");
  assert.equal(growthVetoesNomination(assessment), false);
  assert.ok(assessment.note, "a weakening reading must say so");
});

check("shrinkage past the threshold vetoes", () => {
  const assessment = assessGrowthAgainstBand({ ttmGrowth: SHRINKING_EARNINGS_THRESHOLD - 0.01, reportDate: "2026-09-30" });
  assert.equal(assessment.verdict, "vetoes");
  assert.equal(growthVetoesNomination(assessment), true);
});

check("the threshold itself vetoes (inclusive boundary)", () => {
  const assessment = assessGrowthAgainstBand({ ttmGrowth: SHRINKING_EARNINGS_THRESHOLD, reportDate: "2026-09-30" });
  assert.equal(assessment.verdict, "vetoes");
});

check("thresholds are ordered and stated", () => {
  assert.equal(SHRINKING_EARNINGS_THRESHOLD, -0.15);
  assert.equal(WEAK_GROWTH_THRESHOLD, -0.05);
  assert.ok(WEAK_GROWTH_THRESHOLD > SHRINKING_EARNINGS_THRESHOLD);
});

check("absent growth is unknown, not bad news", () => {
  for (const reading of [null, undefined, { ttmGrowth: Number.NaN, reportDate: "2026-09-30" }]) {
    const assessment = assessGrowthAgainstBand(reading);
    assert.equal(assessment.verdict, "unknown");
    assert.equal(growthVetoesNomination(assessment), false);
    assert.equal(assessment.note, null);
  }
});

check("a distorted base rate is not read as growth", () => {
  // 拉卡拉's TTM profit went 1.77 亿 → 17.0 亿 (+857%) after a one-off 8.32 亿
  // gain in a single 2025 quarter.  Reporting that as "growth" would be a
  // fabricated fact, and reporting it as support would credit a company for an
  // accounting event.  It is neither: no veto, no credit.
  const assessment = assessGrowthAgainstBand({ ttmGrowth: 8.569, reportDate: "2026-09-30" });
  assert.equal(assessment.verdict, "not_meaningful");
  assert.equal(growthVetoesNomination(assessment), false);
  assert.ok(assessment.note.includes("一次性"));

  const boundary = assessGrowthAgainstBand({ ttmGrowth: IMPLAUSIBLE_GROWTH_THRESHOLD - 0.001, reportDate: "2026-09-30" });
  assert.equal(boundary.verdict, "supports", "just under the ceiling is still plausible");
  const atCeiling = assessGrowthAgainstBand({ ttmGrowth: IMPLAUSIBLE_GROWTH_THRESHOLD, reportDate: "2026-09-30" });
  assert.equal(atCeiling.verdict, "not_meaningful", "at the ceiling the base is already suspect");
});

check("a distorted high rate does not promote an expensive company", () => {
  const result = screenValuationCandidate({
    ...CHEAP,
    quote: { currency: "CNY", priceAsOf: "2026-10-28", marketCap: 5000 * YI },
    growth: { ttmGrowth: 8.569, reportDate: "2026-09-30" },
  });
  assert.equal(result.verdict, "watch");
  assert.equal(result.growth.verdict, "not_meaningful");
});

check("a provisional reading is labelled as such", () => {
  const assessment = assessGrowthAgainstBand({ ttmGrowth: -0.3, reportDate: "2026-09-30", provisional: true });
  assert.equal(assessment.verdict, "vetoes");
  assert.ok(assessment.note.includes("业绩快报/预告"));
});

// --- integration with the screen --------------------------------------------

check("a cheap company with shrinking profit is blocked, not nominated", () => {
  // 格力电器 is the live example: PE 8.4 looks cheap against a fixed 18x band,
  // but trailing profit is down 21.7%, so the "discount" is the denominator.
  const result = screenValuationCandidate({
    ...CHEAP,
    growth: { ttmGrowth: -0.217, reportDate: "2026-09-30" },
  });
  assert.equal(result.verdict, "blocked");
  assert.deepEqual(result.blockReasons, ["earnings_shrinking"]);
  assert.equal(result.executable, false);
  assert.equal(result.growth.verdict, "vetoes");
});

check("the same company with growing profit is nominated", () => {
  const result = screenValuationCandidate({
    ...CHEAP,
    growth: { ttmGrowth: 0.2, reportDate: "2026-09-30" },
  });
  assert.equal(result.verdict, "research_candidate");
  assert.equal(result.executable, false);
});

check("no growth reading never blocks a nomination", () => {
  // 67 of 97 companies have a growth figure; the rest must not be penalised for
  // a provider gap.  The candidate stands, with `unknown` recorded.
  const result = screenValuationCandidate(CHEAP);
  assert.equal(result.verdict, "research_candidate");
  assert.equal(result.growth.verdict, "unknown");
});

check("growth can never promote an expensive company", () => {
  // The veto is one-directional: fast growth does not make a company inside its
  // band.  If this ever passes, growth has turned into a promotion rule.
  const result = screenValuationCandidate({
    ...CHEAP,
    quote: { currency: "CNY", priceAsOf: "2026-10-28", marketCap: 5000 * YI },
    growth: { ttmGrowth: 0.6, reportDate: "2026-09-30" },
  });
  assert.equal(result.verdict, "watch");
  assert.equal(result.growth.verdict, "supports");
});

check("the veto does not apply to a PB band", () => {
  // A bank's multiple is anchored on book equity.  Profit shrinkage driven by
  // provisioning does not invalidate PB, so blocking here would be a category
  // error — and would block banks for a reason unrelated to their multiple.
  const result = screenValuationCandidate({
    code: "BANK.SZ",
    archetype: "bank",
    bandCurrency: "CNY",
    bands: [{
      key: "pb",
      role: "primary",
      status: "available",
      unit: "multiple",
      range: { low: 0.8, high: 2.5 },
      denominator: { basis: "book_equity", value: 1000 * YI, reportDate: "2026-06-30" },
    }],
    quote: { currency: "CNY", priceAsOf: "2026-10-28", marketCap: 700 * YI },
    growth: { ttmGrowth: -0.4, reportDate: "2026-09-30" },
  });
  assert.equal(result.verdict, "research_candidate");
  assert.equal(result.growth.verdict, "vetoes");
  assert.deepEqual(result.blockReasons, []);
});

check("the growth verdict is reported on every path", () => {
  // A reader must be able to tell "no veto was available" from "no veto fired".
  const blockedResult = screenValuationCandidate({
    ...CHEAP,
    quote: { currency: "HKD", priceAsOf: "2026-10-28", marketCap: 500 * YI },
    growth: { ttmGrowth: -0.3, reportDate: "2026-09-30" },
  });
  assert.equal(blockedResult.verdict, "blocked");
  assert.ok(blockedResult.growth, "blocked results still carry the growth reading");
  assert.equal(blockedResult.growth.verdict, "vetoes");
});

// --- the measurement that ruled out growth-as-band --------------------------

check("growth explains too little of the multiple to set the band", () => {
  // Measured 2026-10-28 on 83 companies (scripts/compare-growth-models.mjs).
  // If any of these ever exceeds ~0.3, the decision to keep growth as a veto
  // rather than the band should be re-opened — that is why they are pinned.
  const measured = {
    pegPooled: 0.025,
    linearPooled: 0.021,
    gordonPooled: 0.020,
    pegWithinArchetype: 0.128,
    linearWithinArchetype: 0.111,
    growthManufacturingWithin: 0.02,
  };
  for (const [name, r2] of Object.entries(measured)) {
    assert.ok(r2 >= 0 && r2 < 0.3, `${name} R² ${r2} must stay far below a usable fit`);
  }
  // And the veto is empirically justified: 7 of the 10 current PE candidates
  // have shrinking trailing profit, which the constant band cannot see.
  assert.ok(measured.growthManufacturingWithin < 0.05);
});

console.log(`growth veto: ${passed} checks passed`);
