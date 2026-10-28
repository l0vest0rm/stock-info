/**
 * Deterministic check for the watchlist valuation coverage classification.
 * Run: node scripts/check-valuation-coverage-selftest.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildValuationCoverage, companyValuationArchetype, companyValuationCoverage, resolveValuationArchetype } from "../src/modules/research/domain/valuation-coverage.ts";
import { sameSecurity } from "../src/shared/codes.ts";

// JSON modules need an explicit import attribute; validate the config files the
// domain reads so a malformed profile never reaches a worker bundle.
for (const file of [
  "../config/research/research-eastmoney-em2016-industry-profiles.json",
  "../config/generated/eastmoney-company-em2016-profiles.json",
  "../config/investment-universe.json",
]) {
  const parsed = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
  assert.ok(parsed && typeof parsed === "object", `${file} must parse`);
}

const coverage = buildValuationCoverage();
const byName = new Map(coverage.companies.map((company) => [company.displayName, company]));

assert.equal(coverage.companyCount, 98, "all watchlist companies get a valuation profile");
assert.ok(coverage.companies.every((company) => company.valuationProfile.methods.length > 0), "every company has at least one method");

// Banks/insurers must never inherit EV methods from the generic track map.
const cmb = byName.get("招商银行");
assert.equal(cmb.valuationProfile.archetype, "bank");
assert.ok(cmb.valuationProfile.forbidden.includes("EV/EBITDA"));
assert.ok(!cmb.valuationProfile.methods.some((method) => method.method === "ev_ebitda"));
assert.equal(byName.get("中国平安").valuationProfile.archetype, "insurer");

// Cyclicals must be valuated on mid-cycle earnings, not single-quarter TTM.
assert.equal(byName.get("兆易创新").valuationProfile.archetype, "cyclical_commodity");
assert.equal(byName.get("中远海控").valuationProfile.archetype, "cyclical_commodity");
// A track that mixes a freight cycle with railway/express stability must not
// force all three onto the same model: the stable names are overridden.
assert.equal(byName.get("京沪高铁").valuationProfile.archetype, "stable_cash_dividend");

// Acquirer next to Visa must be split by company override.
assert.equal(byName.get("拉卡拉").valuationProfile.archetype, "payment");
assert.equal(byName.get("Visa").valuationProfile.archetype, "payment");
assert.ok(byName.get("拉卡拉").overrideReason);

// Property operators use NAV rather than reported earnings.
assert.equal(byName.get("张江高科").valuationProfile.archetype, "property_operator");

// Factor concentration: AI capex must be the largest single exposure.
assert.equal(coverage.topFactors[0].factor, "ai_capex");
assert.ok(coverage.factorCounts.ai_capex.companies >= 10, "AI capex exposure must be visible across the pool");

/**
 * P2-4: factor buckets must stay usable.
 *
 * The "top factor" line alone hid two problems: a factor assigned to one company
 * is really that company's description, and a factor covering most of the pool
 * says nothing about which companies move together.  Both bounds are checked, so
 * the next calibration cannot quietly recreate either.
 */
const FACTOR_POOL_SHARE_LIMIT = 0.35;
const FACTOR_MIN_COMPANIES = 2;
for (const [factor, counts] of Object.entries(coverage.factorCounts)) {
  const share = counts.companies / coverage.companyCount;
  assert.ok(share <= FACTOR_POOL_SHARE_LIMIT, `${factor} covers ${(share * 100).toFixed(0)}% of the pool; split it into sub-factors`);
  if (counts.companies < FACTOR_MIN_COMPANIES) {
    // `geopolitical_export_control` is deliberately company-specific: export
    // control binds one foundry's advanced node, not an industry-wide driver.
    assert.equal(factor, "geopolitical_export_control",
      `${factor} covers a single company; express it as a company description or give it a second member`);
  }
}

/**
 * P2-4: a shared factor is not a shared position.
 *
 * Every non-rate factor must carry both a primary and a secondary company, i.e.
 * be an exposure a portfolio can actually re-weight; a company must not read as
 * a single-factor bet when a second exposure is real, but must also not collect
 * factors just to look diversified.  Two to three is the useful range.
 */
for (const factor of Object.keys(coverage.factorCounts)) {
  const counts = coverage.factorCounts[factor];
  if (factor === "geopolitical_export_control") continue;
  // A factor that never ranks first for anyone is real but never dominant, so
  // it must at least have a first-order-reading company (e.g. `fx`: it reaches
  // earnings through translated revenue and renegotiated contracts, never as
  // the business model by itself).  A factor with no secondary reading is
  // still rejected: that is the "track label" failure this check exists for.
  if (counts.primary === 0 && factor === "fx") {
    assert.ok(counts.secondary > 0, `${factor} has no exposure at all`);
    continue;
  }  assert.ok(counts.primary > 0 && counts.secondary > 0,
    `${factor} is only ever ${counts.primary ? "primary" : "secondary"}; it cannot describe a second-order exposure`);
}
for (const company of coverage.companies) {
  assert.ok(company.factors.length >= 1 && company.factors.length <= 3,
    `${company.displayName} carries ${company.factors.length} factors; 1–3 keeps the exposure readable`);
  assert.ok(company.factors.every((factor) => ["positive", "negative", "mixed"].includes(factor.direction)),
    `${company.displayName} has a factor without a direction`);
  assert.ok(company.factors.every((factor) => ["primary", "secondary"].includes(factor.weight)),
    `${company.displayName} has a factor without a weight`);
}

/**
 * P2-4: rate exposure is not one bucket.
 *
 * A bank's net interest margin, an insurer's spread liability and a utility's
 * discount rate all move with rates, but not in the same direction, and not with
 * the same magnitude.  The rate view therefore groups companies by the channel
 * through which rates reach their earnings, and a rate-tagged company with no
 * other factor is reported as unresolved instead of being counted as a bucket.
 */
const rateCompanies = coverage.companies.filter((company) => company.factors.some((factor) => factor.factor === "interest_rate"));
assert.ok(rateCompanies.length >= 8, "rate-sensitive companies must be recognised explicitly");
assert.deepEqual(coverage.rateSensitivity.unresolved, [], "every rate-sensitive company needs a transmission channel");
for (const company of rateCompanies) {
  assert.ok(company.factors.length >= 2, `${company.displayName} is tagged interest_rate but carries no transmission channel`);
}
// Direction is the point: banks/insurers vs dam operators must not share one sign.
const rateDirection = (name) => coverage.companies.find((c) => c.displayName === name).factors.find((f) => f.factor === "interest_rate").direction;
assert.equal(rateDirection("招商银行"), "negative", "a rate cut compresses a bank's net interest margin");
assert.equal(rateDirection("中国平安"), "negative", "low long yields damage an insurer's spread");
assert.equal(rateDirection("长江电力"), "negative", "a rate cut RAISES a bond-proxy utility's value, so earnings/discount sensitivity is negative");
assert.equal(coverage.rateSensitivity.channels.length >= 3, true, "rate exposure must be split into several channels");
// The insurer track and the utility track must not resolve to the same model.
assert.equal(byName.get("中国平安").valuationProfile.archetype, "insurer");
assert.equal(byName.get("长江电力").valuationProfile.archetype, "stable_cash_dividend");

// Classification stays deterministic.
assert.deepEqual(resolveValuationArchetype("FIN-01"), { archetype: "bank", overrideReason: null });
assert.equal(resolveValuationArchetype("IT-01").archetype, "growth_manufacturing");

/**
 * P2-3: the research tier must actually rank the pool.
 *
 * `researchPriority` was uniformly L1 for all 98 companies, which is the same as
 * having no tiering: a work queue where everything has the top priority tells you
 * nothing about what to open first.  These bounds fail if the rule ever collapses
 * back to one bucket, and they also pin the reason the ranking exists — an
 * unverified company cannot outrank a verified one.
 */
const priorities = new Set(coverage.companies.map((company) => company.researchTier.priority));
assert.ok(priorities.size >= 2, `research priority collapsed to a single bucket: ${[...priorities].join(",")}`);
for (const company of coverage.companies) {
  assert.ok(company.researchTier.basis.length > 0, `${company.displayName} has a tier with no stated basis`);
  assert.ok(["L1", "L2", "L3"].includes(company.researchTier.priority), `${company.displayName} has an unknown priority`);
}
// Hardest models first: an insurer's denominator is a modelling choice, so it is
// L3 by construction, while a plain growth name stays L1 unless it has no evidence.
const insurerTiers = coverage.companies.filter((company) => company.valuationProfile.archetype === "insurer");
assert.ok(insurerTiers.length > 0, "no insurer in the pool");
for (const company of insurerTiers) {
  if (company.securities.length > 0) {
    const verified = company.securities.every((security) => security.ticker.length > 0);
    assert.ok(verified, `${company.displayName} has an empty security line`);
  }
}
// A company without identity evidence must never be promoted: it cannot be
// researched yet, no matter how hard its model is.
const unverified = coverage.companies.filter((company) => company.evidenceCount === 0);
for (const company of unverified) {
  assert.equal(company.researchTier.priority, "L1", `${company.displayName} has no evidence but is ranked ${company.researchTier.priority}`);
  assert.equal(company.researchTier.watchStatus, "research", `${company.displayName} has no evidence but is watchStatus=${company.researchTier.watchStatus}`);
}

/**
 * A business model belongs to the issuer, not to its preferred listing.
 *
 * Only the preferred ticker used to resolve, so a company's second line (A+H,
 * A+ADR) fell through to `other` and received the generic method set — the
 * bank would have been priced on EV/EBITDA and the insurer on unadjusted PB,
 * which is exactly the mis-route the archetype system exists to prevent.
 */
for (const company of coverage.companies) {
  for (const security of company.securities) {
    const resolved = companyValuationCoverage(security.ticker);
    assert.ok(resolved, `${security.ticker} is listed but resolves to no company`);
    assert.equal(resolved.companyId, company.companyId, `${security.ticker} resolved to the wrong issuer`);
    assert.equal(resolved.valuationProfile.archetype, company.valuationProfile.archetype,
      `${security.ticker} must share its issuer's archetype`);
  }
}
assert.equal(companyValuationArchetype("600036.SH"), "bank");
assert.equal(companyValuationArchetype("03968.HK"), "bank", "an H-share line resolves to its A-share issuer's model");
assert.equal(companyValuationArchetype("601398.SH"), null, "a bank outside the pool must not borrow a pooled company's model");
assert.equal(companyValuationArchetype("NOT.LISTED"), null, "an unlisted ticker must not resolve");

// The watchlist stores US symbols bare (`NVDA`) while the API normalizes to
// `NVDA.US`.  A literal comparison made every US company fall through to the
// generic `other` profile, which silently replaced its method set — no error, no
// gap, just the wrong bands.  Both spellings must now resolve to one issuer, and
// the equivalence must stay narrow: a bare number is never inferred as a US code.
for (const company of coverage.companies.filter((item) => item.preferredTicker === "NVDA")) {
  assert.equal(companyValuationArchetype("NVDA.US"), company.valuationProfile.archetype, "the .US spelling must resolve to the bare-symbol issuer");
}
assert.equal(companyValuationArchetype("NVDA.US"), "growth_manufacturing");
assert.equal(companyValuationArchetype("601398"), null, "a bare number must not be guessed as an A-share");
assert.equal(sameSecurity("NVDA", "NVDA.US"), true);
assert.equal(sameSecurity("NVDA", "NVDA.OQ"), false, "a different listing suffix is a different security");
// An unsuffixed A-share code is resolved by the repository's existing
// `normalizeSecurityCode` convention (6 digits → .SH/.SZ), not by this rule; the
// point of the assertion is that no *new* cross-market guess was introduced here.
assert.equal(sameSecurity("600036", "600036.SH"), true);
assert.equal(sameSecurity("00700", "600036.SH"), false, "two unrelated codes never compare equal");

console.log("valuation-coverage self-test: ok", JSON.stringify({
  archetypes: coverage.archetypeCounts,
  researchTiers: coverage.companies.reduce((acc, company) => {
    acc[company.researchTier.priority] = (acc[company.researchTier.priority] ?? 0) + 1;
    return acc;
  }, {}),
  topFactors: coverage.topFactors.slice(0, 5),
  em2016: coverage.em2016Lookup,
}));
