// Retained assertion coverage; all domain computations execute in native Rust.
import { callRustSelftest, screenValuationCandidate } from './lib/rust-analysis.mjs';
const nativeConstants = callRustSelftest('constants');
const normalizeCurrency = (...args) => callRustSelftest('normalizeCurrency', ...args);
const SCREEN_MARGIN_OF_SAFETY = nativeConstants.SCREEN_MARGIN_OF_SAFETY;
/**
 * Deterministic check for the research-candidate screen (P3-2).
 * Run: node scripts/check-valuation-screen-selftest.mjs
 *
 * The rule this module exists to enforce is a boundary, not an algorithm: a
 * machine may nominate a company for study, and must never produce a trading
 * instruction.  It cannot, because the two inputs that make an instruction
 * responsible — how much money the owner has and what they already hold — are
 * deliberately absent from every public file.
 *
 * So the assertions are mostly about refusal:
 *
 * - a currency mismatch blocks instead of silently converting (阿里 reports in
 *   CNY and trades in HKD; 友邦 reports in USD and trades in HKD, so a missing
 *   gate is a ~7.8x error that still looks like a number);
 * - an EV-only company blocks instead of comparing enterprise value to a
 *   market cap;
 * - a quote from a different quarter blocks instead of measuring drift;
 * - and no path can ever emit `consider_buy` / `consider_add`.
 */
import assert from "node:assert/strict";


const YI = 100_000_000;

/** An `available` multiple band, shaped exactly as `buildValuationBands` emits it. */
function capBand(overrides = {}) {
  return {
    key: "pe_ttm",
    role: "primary",
    status: "available",
    unit: "multiple",
    range: { low: 8, high: 18 },
    // denominator 100 亿 ⇒ implied 800 亿 .. 1800 亿
    denominator: { basis: "net_income_ttm", value: 100 * YI, reportDate: "2026-06-30" },
    ...overrides,
  };
}

/** An `available` yield band: the flow is a percentage of market cap. */
function yieldBand(overrides = {}) {
  return {
    key: "fcf_yield",
    role: "primary",
    status: "available",
    unit: "percent",
    range: { low: 3, high: 6 },
    denominator: { basis: "free_cash_flow_ttm", value: 50 * YI, reportDate: "2026-06-30" },
    ...overrides,
  };
}

const base = {
  code: "TEST.SZ",
  archetype: "growth_manufacturing",
  bandCurrency: "CNY",
};

const quote = (marketCap, overrides = {}) => ({
  currency: "CNY",
  priceAsOf: "2026-08-01",
  marketCap,
  ...overrides,
});

// --- 1. Inside the range with margin ⇒ research candidate ------------------
// 1000 亿 against an 1800 亿 high end ⇒ 44% margin.
const candidate = screenValuationCandidate({ ...base, bands: [capBand()], quote: quote(1000 * YI) });
assert.equal(candidate.verdict, "research_candidate");
assert.ok(candidate.position.marginOfSafety > SCREEN_MARGIN_OF_SAFETY);
assert.equal(candidate.executable, false, "a screen is never executable");
assert.equal(candidate.basis.key, "pe_ttm");
assert.equal(candidate.position.impliedHigh, 1800 * YI);

// --- 2. Above the range ⇒ watch, not "expensive" as an action -------------
const rich = screenValuationCandidate({ ...base, bands: [capBand()], quote: quote(2000 * YI) });
assert.equal(rich.verdict, "watch");
assert.ok(rich.position.marginOfSafety < 0);

// Inside the range but with too little discount: 1750/1800 ⇒ 2.8%.
const thin = screenValuationCandidate({ ...base, bands: [capBand()], quote: quote(1750 * YI) });
assert.equal(thin.verdict, "watch", "inside the range is not the same as a discount");

// --- 3. Missing quote is its own block, not an empty model ----------------
//
// This is a real defect that the live run caught: the screen used to read
// `band.implied.metric` to decide comparability, but the band engine drops
// `implied` entirely when no market cap is available.  688256.SH had a valid
// 30x PE band and was reported as `no_available_band` — a provider outage
// disguised as "no valuation method applies".
const noQuote = screenValuationCandidate({ ...base, bands: [capBand()], quote: null });
assert.deepEqual(noQuote.blockReasons, ["quote_missing"]);
assert.equal(noQuote.basis, null);

const noMarketCap = screenValuationCandidate({ ...base, bands: [capBand()], quote: quote(null) });
assert.deepEqual(noMarketCap.blockReasons, ["quote_missing"]);

// A structural currency gap must not be reported as a provider outage.  All
// five HK lines in the watchlist trade in HKD while reporting in CNY or USD,
// and their market cap is also unavailable — reporting `quote_missing` would
// imply "fetch the quote and it will work", which is false.  The currency gate
// therefore runs first.
const hkStructural = screenValuationCandidate({
  ...base,
  bandCurrency: "人民币",
  bands: [capBand()],
  quote: quote(null, { currency: "HKD" }),
});
assert.deepEqual(
  hkStructural.blockReasons,
  ["currency_mismatch"],
  "a structural currency gap outranks a missing quote",
);

// A band that is genuinely unavailable still reports so.
const none = screenValuationCandidate({
  ...base,
  bands: [capBand({ status: "insufficient_data", denominator: null, range: null })],
  quote: quote(1000 * YI),
});
assert.deepEqual(none.blockReasons, ["no_available_band"]);

// --- 4. Currency mismatch blocks (the 阿里巴巴 / 友邦 trap) ----------------
const mismatch = screenValuationCandidate({
  ...base,
  bands: [capBand()],
  quote: quote(1000 * YI, { currency: "HKD" }),
});
assert.equal(mismatch.verdict, "blocked");
assert.deepEqual(mismatch.blockReasons, ["currency_mismatch"]);
assert.match(mismatch.note, /CNY/);
assert.match(mismatch.note, /HKD/);

// Eastmoney returns HK reporting currency in Chinese while quotes are ISO.
// Those are the same currency; treating them as different blocks every HK
// company for the wrong reason, and treating unknown text as equal lets a real
// mismatch through.
assert.equal(normalizeCurrency("人民币"), "CNY");
assert.equal(normalizeCurrency("美元"), "USD");
assert.equal(normalizeCurrency("港元"), "HKD");
assert.equal(normalizeCurrency("CNY"), "CNY");
assert.equal(normalizeCurrency(""), null);
assert.equal(normalizeCurrency("EURO"), null, "an unknown currency must not be assumed to match");

const chinese = screenValuationCandidate({
  ...base,
  bandCurrency: "人民币",
  bands: [capBand()],
  quote: quote(1000 * YI, { currency: "CNY" }),
});
assert.equal(chinese.verdict, "research_candidate", "人民币 and CNY are the same currency");

const unknownCurrency = screenValuationCandidate({
  ...base,
  bandCurrency: null,
  bands: [capBand()],
  quote: quote(1000 * YI),
});
assert.deepEqual(unknownCurrency.blockReasons, ["currency_unknown"]);

// A missing currency and a conflicting one are different facts.  Conflating them
// is how 生益科技 — an A-share reporting in CNY — got reported as a currency
// mismatch when the real cause was that its newest income row was a 业绩预告 and
// therefore carried no CURRENCY field.  The refusal was right; the diagnosis was
// wrong, and a wrong diagnosis is what makes the next fix go to the wrong place.
assert.match(unknownCurrency.note, /币种缺失/);
assert.doesNotMatch(unknownCurrency.note, /以 \w+ 计价/);

// --- 5. EV-only companies block -------------------------------------------
const evOnly = screenValuationCandidate({
  ...base,
  bands: [capBand({
    key: "ev_ebit",
    denominator: { basis: "ebit_ttm", value: 100 * YI, reportDate: "2026-06-30" },
    range: { low: 8, high: 16 },
  })],
  quote: quote(1000 * YI),
});
assert.equal(evOnly.verdict, "blocked");
assert.deepEqual(evOnly.blockReasons, ["no_market_cap_band"], "EV is not a market cap");

// --- 6. Staleness uses the band the verdict rests on -----------------------
//
// A company can carry bands anchored on different statements.  Checking the
// first available band instead of the chosen one measures the wrong anchor, so
// a fresh PE next to a year-old PB could pass or fail for no reason.
const stale = screenValuationCandidate({
  ...base,
  bands: [capBand()],
  quote: quote(1000 * YI, { priceAsOf: "2026-12-31" }),
});
assert.deepEqual(stale.blockReasons, ["stale_basis"]);

// A quote with no date cannot be shown to be one observation.
const undated = screenValuationCandidate({
  ...base,
  bands: [capBand()],
  quote: quote(1000 * YI, { priceAsOf: null }),
});
assert.deepEqual(undated.blockReasons, ["stale_basis"]);

// The chosen band is the primary PE; an ancient auxiliary PB must not decide.
const mixedAge = screenValuationCandidate({
  ...base,
  bands: [
    capBand({ key: "pb", role: "auxiliary", unit: "multiple", range: { low: 0.8, high: 2.5 }, denominator: { basis: "book_equity", value: 500 * YI, reportDate: "2024-01-01" } }),
    capBand(),
  ],
  quote: quote(1000 * YI),
});
assert.equal(mixedAge.verdict, "research_candidate", "staleness must be judged on the chosen band, not any available one");
assert.equal(mixedAge.basis.key, "pe_ttm");

// --- 6b. A through-cycle band is not stale just because it is annual -------
//
// A mid-cycle band's newest observation *is* the last completed fiscal year.
// Applying the 120-day trailing-flow bound blocked all ten cyclicals in the
// watchlist every single day (中远海控, 紫金矿业, 万华化学, 中国海油 …), which
// looks like "no valuation" while the model works as designed.
const midCycleBand = (reportDate) => ({
  key: "pe_mid_cycle",
  role: "primary",
  status: "available",
  unit: "multiple",
  range: { low: 8, high: 15 },
  denominator: { basis: "net_income_mid_cycle", value: 100 * YI, reportDate },
});
const annualAnchor = screenValuationCandidate({
  ...base,
  archetype: "cyclical_commodity",
  bands: [midCycleBand("2025-12-31")],
  // 301 days later: a normal October quote against the last annual report.
  quote: quote(1000 * YI, { priceAsOf: "2026-10-28" }),
});
assert.equal(annualAnchor.verdict, "research_candidate", "an annual anchor is current until the next annual exists");

// But a band that missed a whole cycle is stale, not merely annual.
const missedCycle = screenValuationCandidate({
  ...base,
  archetype: "cyclical_commodity",
  bands: [midCycleBand("2024-12-31")],
  quote: quote(1000 * YI, { priceAsOf: "2026-10-28" }),
});
assert.deepEqual(missedCycle.blockReasons, ["stale_basis"]);
assert.match(missedCycle.note, /缺一个完整年度/);

// --- 7. Yield bands compare in the opposite direction ---------------------
//
// A yield band says the flow should be 3–6% of the price.  Cheaper price ⇒
// higher yield ⇒ the discount is *above* the upper bound.  Reading it like a
// multiple inverts the conclusion and would call every expensive company cheap.
// FCF 50 亿 at 800 亿 ⇒ 6.25%, just above the 6% upper bound ⇒ ~4% margin.
const yieldThin = screenValuationCandidate({ ...base, bands: [yieldBand()], quote: quote(800 * YI) });
assert.equal(yieldThin.verdict, "watch", "a 4% overshoot is inside the noise band");
assert.equal(yieldThin.basis.unit, "percent");

// FCF 50 亿 at 500 亿 ⇒ 10% ⇒ 67% above the upper bound.
const yieldCheap = screenValuationCandidate({ ...base, bands: [yieldBand()], quote: quote(500 * YI) });
assert.equal(yieldCheap.verdict, "research_candidate");

// FCF 50 亿 at 2000 亿 ⇒ 2.5% ⇒ below the 3% floor.
const yieldRich = screenValuationCandidate({ ...base, bands: [yieldBand()], quote: quote(2000 * YI) });
assert.equal(yieldRich.verdict, "watch");

// --- 8. A primary band outranks an auxiliary one --------------------------
const mixed = screenValuationCandidate({
  ...base,
  bands: [
    capBand({ key: "pb", role: "auxiliary", unit: "multiple", range: { low: 0.8, high: 2.5 }, denominator: { basis: "book_equity", value: 500 * YI, reportDate: "2026-06-30" } }),
    capBand(),
  ],
  quote: quote(1000 * YI),
});
assert.equal(mixed.basis.key, "pe_ttm", "a primary band outranks an auxiliary one");

// Two primaries compete (growth_manufacturing marks both PE and FCF as
// primary); earnings outrank cash-flow yield, and the choice is stable.
const twoPrimaries = screenValuationCandidate({
  ...base,
  bands: [yieldBand(), capBand()],
  quote: quote(1000 * YI),
});
assert.equal(twoPrimaries.basis.key, "pe_ttm", "earnings multiples outrank yield ranges");
const reversed = screenValuationCandidate({
  ...base,
  bands: [capBand(), yieldBand()],
  quote: quote(1000 * YI),
});
assert.equal(reversed.basis.key, "pe_ttm", "band order must not change the verdict");

// --- 8b. An auxiliary-only company never becomes a candidate --------------
//
// An insurer's archetype makes PE "辅助，不单独使用": its profit is moved by
// investment returns and reserve assumptions.  With P/EV and PB-ROEV both
// unavailable (no EV or NBV feed), PE was the only computable band, and 中国平安
// screened as 67% cheap — a wide margin that measured the wrong method.  An
// auxiliary band may still be shown as a watch, never promoted.
const insurerAux = screenValuationCandidate({
  ...base,
  archetype: "insurer",
  bands: [capBand({ role: "auxiliary", key: "pe_ttm" })],
  quote: quote(1000 * YI),
});
assert.equal(insurerAux.verdict, "watch", "an auxiliary band alone cannot justify a candidate");
assert.match(insurerAux.note, /辅助方法/);
assert.equal(insurerAux.position.marginOfSafety > SCREEN_MARGIN_OF_SAFETY, true, "the discount is reported, just not promoted");

// With a primary band present the same discount does promote, so the guard
// removes the method problem without suppressing genuine signals.
const insurerPrm = screenValuationCandidate({
  ...base,
  archetype: "insurer",
  bands: [
    capBand({ role: "auxiliary", key: "pe_ttm" }),
    capBand({ key: "pb", role: "primary", unit: "multiple", range: { low: 0.8, high: 2.5 }, denominator: { basis: "book_equity", value: 500 * YI, reportDate: "2026-06-30" } }),
  ],
  quote: quote(1000 * YI),
});
assert.equal(insurerPrm.verdict, "research_candidate");
assert.equal(insurerPrm.basis.key, "pb");

// --- 9. The output vocabulary contains no instruction ---------------------
//
// This is the actual product requirement: `consider_buy` / `consider_add` are
// human actions that require the owner's account, which the machine never sees.
const verdicts = [candidate, rich, thin, mismatch, evOnly, none, noQuote, noMarketCap, stale, undated, yieldCheap, yieldRich]
  .map((result) => result.verdict);
const ALLOWED = new Set(["research_candidate", "watch", "blocked"]);
for (const verdict of verdicts) {
  assert.ok(ALLOWED.has(verdict), `unexpected verdict: ${verdict}`);
  assert.ok(!/consider_(buy|add|trim|exit)/.test(verdict), "a screen must never emit a trading action");
}

// Every result carries `executable: false`, including the blocked ones.
for (const result of [candidate, rich, mismatch, evOnly, stale, yieldCheap]) {
  assert.equal(result.executable, false);
}

// --- 10. Each block reason is reachable, so none is dead code -------------
const reachable = new Set(
  [mismatch, evOnly, none, noQuote, stale]
    .flatMap((result) => result.blockReasons)
    .concat(unknownCurrency.blockReasons),
);
assert.deepEqual(
  [...reachable].sort(),
  ["currency_mismatch", "currency_unknown", "no_available_band", "no_market_cap_band", "quote_missing", "stale_basis"],
  "every declared block reason must be produced by some input",
);

console.log("valuation-screen self-test: ok", {
  candidateMargin: `${(candidate.position.marginOfSafety * 100).toFixed(1)}%`,
  yieldCheapYield: `${((50 / 500) * 100).toFixed(2)}%`,
  blockReasons: [...reachable].sort(),
});
