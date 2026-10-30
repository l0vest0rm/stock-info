// Retained assertion coverage; all domain computations execute in native Rust.
import { callRustSelftest } from './lib/rust-analysis.mjs';
const eastmoneyMarketCapYi = (...args) => callRustSelftest('eastmoneyMarketCapYi', ...args);
const eastmoneyPriceDivisor = (...args) => callRustSelftest('eastmoneyPriceDivisor', ...args);
/**
 * Deterministic check for Eastmoney quote field scaling.
 * Run: node scripts/check-eastmoney-quote-selftest.mjs
 *
 * This exists because the bug it guards against was invisible in every place
 * we normally look.  Every field was present, nothing was null, and the number
 * was only wrong by 10x — so the company page showed a plausible 市值, the
 * screen produced a plausible verdict, and both were wrong.
 *
 * The real payloads below are copied from live responses on 2026-10-28.
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

// --- f59 drives the divisor -------------------------------------------------

check("A-share declares 2 decimals", () => {
  assert.equal(eastmoneyPriceDivisor(2), 100);
});

check("HK declares 3 decimals", () => {
  assert.equal(eastmoneyPriceDivisor(3), 1000);
});

check("US declares 3 decimals", () => {
  assert.equal(eastmoneyPriceDivisor(3), 1000);
});

check("undefined falls back to the A-share default, not to Infinity", () => {
  assert.equal(eastmoneyPriceDivisor(undefined), 100);
  assert.equal(eastmoneyPriceDivisor(null), 100);
});

check("implausible decimals fall back instead of producing 10**99", () => {
  for (const bad of [-1, 7, 99, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(eastmoneyPriceDivisor(bad), 100, `f59=${bad}`);
  }
});

check("fractional decimals truncate rather than produce a fractional divisor", () => {
  assert.equal(eastmoneyPriceDivisor(2.9), 100);
});

// --- real payloads ----------------------------------------------------------

// 00700.HK: f43=386400, f59=3, f116=3515216490891.4
check("Tencent price is 386.8, not 3864 or 386400", () => {
  assert.equal(386400 / eastmoneyPriceDivisor(3), 386.4);
});
check("Tencent market cap is 35152 亿", () => {
  assert.equal(Math.round(eastmoneyMarketCapYi(3515216490891.4)), 35152);
});

// 600036.SH: f43=4243, f59=2, f116=1071318663600
check("China Merchants Bank price is 42.43", () => {
  assert.equal(4243 / eastmoneyPriceDivisor(2), 42.43);
});
check("China Merchants Bank market cap is 10713 亿", () => {
  assert.equal(Math.round(eastmoneyMarketCapYi(1071318663600)), 10713);
});

// NVDA.US: f43=217940, f59=3, f116=5252354000000
check("NVDA price is 217.94 and market cap is 52524 亿", () => {
  assert.equal(217940 / eastmoneyPriceDivisor(3), 217.94);
  assert.equal(Math.round(eastmoneyMarketCapYi(5252354000000)), 52524);
});

// --- the invariant that actually matters ------------------------------------

check("derived shares agree with the real count within 1%", () => {
  // The company page computes 市值 = price × shares, and the fallback derives
  // shares = marketCap / price.  Tencent has ~9.09e9 shares; reading f43 with
  // the wrong divisor yields 9.09e8, i.e. a 10x error that still looks like a
  // share count.  This pins the identity the two helper functions must honour.
  const cases = [
    { label: "00700.HK", f43: 386400, f59: 3, f116: 3515216490891.4, shares: 9.0926e9 },
    { label: "600036.SH", f43: 4243, f59: 2, f116: 1071318663600, shares: 2.52198e10 },
  ];
  for (const item of cases) {
    const price = item.f43 / eastmoneyPriceDivisor(item.f59);
    const capYi = eastmoneyMarketCapYi(item.f116);
    const derivedShares = (capYi * 100_000_000) / price;
    const drift = Math.abs(derivedShares - item.shares) / item.shares;
    assert.ok(drift < 0.01, `${item.label}: derived ${derivedShares.toFixed(0)} vs real ${item.shares.toFixed(0)}`);
  }
});

check("market cap of an absent f116 is null, not 0", () => {
  // 0 would read as "worthless" and silently pass a <= comparison; null is the
  // honest answer and keeps `quote_missing` distinct from a real zero.
  assert.equal(eastmoneyMarketCapYi(null), null);
  assert.equal(eastmoneyMarketCapYi(undefined), null);
});

console.log(`eastmoney quote scaling: ${passed} checks passed`);
