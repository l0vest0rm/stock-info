// Retained assertion coverage; all domain computations execute in native Rust.
import { callRustSelftest } from './lib/rust-analysis.mjs';
const buildComparabilityMatrix = (...args) => callRustSelftest('buildComparabilityMatrix', ...args);
const capitalIntensityClass = (...args) => callRustSelftest('capitalIntensityClass', ...args);
const comparisonRulesFor = (...args) => callRustSelftest('comparisonRulesFor', ...args);
/**
 * Deterministic check for the comparability matrix.
 * Run: node scripts/check-comparability-matrix-selftest.mjs
 *
 * The invariant that matters: a metric is comparable only when the archetype,
 * the capital-intensity class and the cycle basis all agree.  Refusals are
 * reported with their reason, never silently dropped.
 */
import assert from "node:assert/strict";


// 1. Capital-intensity classes follow the measured thresholds.
assert.equal(capitalIntensityClass(0.07), "light", "中际旭创");
assert.equal(capitalIntensityClass(0.49), "light");
assert.equal(capitalIntensityClass(0.5), "medium");
assert.equal(capitalIntensityClass(0.8), "medium");
assert.equal(capitalIntensityClass(1.44), "heavy", "中远海控");
assert.equal(capitalIntensityClass(5.6), "heavy", "比亚迪 / 中芯国际");
assert.equal(capitalIntensityClass(null), "unknown");

// 2. Same archetype, same capital intensity: EV/EBITDA is comparable.
const manufacturingPeers = buildComparabilityMatrix({
  company: { code: "300308.SZ", depreciationToEbit: 0.07 },
  peers: [{ code: "300394.SZ", depreciationToEbit: 0.2 }],
});
assert.equal(manufacturingPeers.archetype, "growth_manufacturing");
assert.ok(manufacturingPeers.peers[0].comparableMetrics.includes("ev_ebitda"));
assert.ok(manufacturingPeers.peers[0].comparableMetrics.includes("ev_ebit"));

// 3. Same archetype, different capital intensity: only capital-neutral metrics survive.
const mixed = buildComparabilityMatrix({
  company: { code: "300308.SZ", depreciationToEbit: 0.07 },
  peers: [{ code: "002594.SZ", depreciationToEbit: 5.6 }],
});
const mixedPair = mixed.peers[0];
assert.equal(mixedPair.comparableMetrics.includes("ev_ebitda"), false, "EV/EBITDA is refused across capital classes");
assert.ok(mixedPair.blocked.some((item) => item.metric === "ev_ebitda" && item.reason.includes("资本密度不同")));
assert.ok(mixedPair.comparableMetrics.includes("ev_ebit"), "EV/EBIT stays comparable — it already carries depreciation");
assert.ok(mixedPair.comparableMetrics.includes("pe_ttm"), "PE is capital-neutral");

// 4. Different archetypes: everything is refused with the archetype reason.
const crossArchetype = buildComparabilityMatrix({
  company: { code: "300308.SZ", depreciationToEbit: 0.07 },
  peers: [{ code: "600519.SH", depreciationToEbit: 0.04 }],
});
assert.equal(crossArchetype.peers[0].comparableMetrics.length, 0);
assert.ok(crossArchetype.peers[0].blocked.every((item) => item.reason.includes("业务模型不同")));

// 5. A bank forbids EV metrics at the archetype level.
const bank = buildComparabilityMatrix({ company: { code: "600036.SH" }, peers: [] });
assert.deepEqual(bank.forbiddenMetrics.sort(), ["ev_ebit", "ev_ebitda", "ev_revenue", "fcf_yield"].sort());
assert.equal(bank.archetypeMetrics.includes("ev_ebit"), false);

// 6. Cyclicals without a mid-cycle centre cannot be compared on profit multiples.
const cyclical = buildComparabilityMatrix({
  company: { code: "601919.SH", depreciationToEbit: 0.6, midCycleAvailable: true },
  peers: [{ code: "601899.SH", depreciationToEbit: 0.5, midCycleAvailable: false }],
});
assert.equal(cyclical.peers[0].comparableMetrics.includes("pe_ttm"), false, "TTM PE refused when one side has no centre");
assert.equal(cyclical.peers[0].comparableMetrics.includes("pe_mid_cycle"), false);
assert.ok(cyclical.peers[0].blocked.some((item) => item.reason.includes("中枢利润")));
assert.ok(cyclical.notes.some((text) => text.includes("周期两端都失真")));

// 7. Both sides having a centre makes mid-cycle PE comparable.
const cyclicalOk = buildComparabilityMatrix({
  company: { code: "601919.SH", depreciationToEbit: 0.5, midCycleAvailable: true },
  peers: [{ code: "601899.SH", depreciationToEbit: 0.6, midCycleAvailable: true }],
});
assert.ok(cyclicalOk.peers[0].comparableMetrics.includes("pe_mid_cycle"));

// 8. A missing denominator is a refusal, not a blank comparison.
const noDenominator = buildComparabilityMatrix({
  company: { code: "300308.SZ", depreciationToEbit: 0.07, availableMetrics: ["pe_ttm"] },
  peers: [{ code: "300394.SZ", depreciationToEbit: 0.2, availableMetrics: ["pe_ttm"] }],
});
assert.deepEqual(noDenominator.peers[0].comparableMetrics, ["pe_ttm"]);
assert.ok(noDenominator.peers[0].blocked.some((item) => item.reason.includes("缺少该口径的分母")));

// 9. Unknown capital intensity blocks intensity-sensitive metrics.
const unknown = buildComparabilityMatrix({
  company: { code: "601318.SH" },
  peers: [],
});
assert.equal(unknown.capitalIntensity.class, "unknown");
assert.ok(unknown.notes.some((text) => text.includes("无法判定资本密度")));

// 10. Every archetype exposes a rule set, including `other`.
for (const archetype of ["bank", "insurer", "exchange", "payment", "property_operator", "cyclical_commodity", "stable_cash_dividend", "growth_manufacturing", "software_platform", "pre_profit_milestone", "healthcare_services", "other"]) {
  const rules = comparisonRulesFor(archetype);
  assert.ok(Array.isArray(rules.allowed) && Array.isArray(rules.forbidden), `${archetype} has rules`);
  const overlap = rules.allowed.filter((metric) => rules.forbidden.includes(metric));
  assert.deepEqual(overlap, [], `${archetype} never both allows and forbids a metric`);
}
assert.ok(comparisonRulesFor("pre_profit_milestone").forbidden.includes("pe_ttm"));

console.log("comparability-matrix self-test: ok", {
  mixedComparable: mixedPair.comparableMetrics,
  mixedBlocked: mixedPair.blocked.map((item) => item.metric),
  bankForbidden: bank.forbiddenMetrics,
});
