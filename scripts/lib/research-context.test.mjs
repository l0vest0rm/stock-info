import assert from "node:assert/strict";
import test from "node:test";
import { buildResearchContext, registerResearchSources } from "./research-context.mjs";

const baseInput = {
  researchTaskId: "research-analysis:300308.SZ:2026-08-09T00:00:00.000Z",
  asOf: "2026-08-09T00:00:00.000Z",
  company: { companyId: "company:300308", name: "测试公司", reportingCurrency: "CNY" },
  security: { securityId: "security:300308.SZ", securityCode: "300308.SZ", listingVenue: "SZ", tradingCurrency: "CNY", shareClass: "A" },
  reportingBoundary: { latestFiledPeriod: "2026-03-31", latestAnnualPeriod: "2025-12-31", laterProvisionalUpdates: [] },
  financialSnapshot: { asOf: "2026-08-09T00:00:00.000Z", schemaVersion: "financial-read-model.v1", source: "eastmoney", periods: ["2026-03-31"], incomeStatement: [], balanceSheet: [], cashFlowStatement: [], deterministicMetrics: [], qualityIssues: [] },
  marketSnapshot: { asOf: "2026-08-09T00:00:00.000Z", schemaVersion: "market-snapshot.v1", source: "xueqiu", securityId: "security:300308.SZ", securityCode: "300308.SZ", listingVenue: "SZ", shareClass: "A", tradingCurrency: "CNY", sharesOutstanding: 123, rights: { voting: "one_vote_per_share" }, historicalValuation: [{ asOf: "2026-03-31", metric: "pe_ttm", value: 22 }], periods: [], price: 10, marketCapitalization: 100, currency: "CNY", reportedMultiples: {}, qualityIssues: [] },
  scopeEnvelope: { products: ["产品"], customers: ["客户"], regions: ["中国"], uses: ["用途"], segments: [], uncertainBoundaries: ["未披露客户集中度"], basisSourceIds: ["source:filing"] },
  sources: [{ url: "https://example.test/filing", title: "年报", publishedAt: "2026-04-01", subject: "测试公司", role: "formal_disclosure", retrievedAt: "2026-08-09T00:00:00.000Z", contentFingerprint: "sha256:filing", availabilityStatus: "available", limitations: [] }],
};

test("S0 context is deterministic and preserves one immutable input fingerprint", () => {
  const first = buildResearchContext(baseInput);
  const second = buildResearchContext(structuredClone(baseInput));
  assert.equal(first.inputFingerprint, second.inputFingerprint);
  assert.equal(first.contextVersion, "research-context.v1");
  assert.equal(first.sourceRegistryId, second.sourceRegistryId);
  assert.deepEqual(first.knownSourceIds, second.knownSourceIds);
  assert.equal(first.quality.status, "available");
  assert.equal(first.marketSnapshot.sharesOutstanding, 123);
  assert.equal(first.marketSnapshot.rights.voting, "one_vote_per_share");
  assert.equal(first.marketSnapshot.historicalValuation[0].metric, "pe_ttm");
  const revisedMarket = buildResearchContext({ ...baseInput, marketSnapshot: { ...baseInput.marketSnapshot, sharesOutstanding: 124 } });
  assert.notEqual(first.inputFingerprint, revisedMarket.inputFingerprint);
  assert.equal("webSearch" in first, false);
  assert.equal("judgments" in first, false);
});

test("scope uncertainty is explicit and never inferred from ticker or company name", () => {
  const context = buildResearchContext({ ...baseInput, scopeEnvelope: null });
  assert.equal(context.scopeEnvelope, null);
  assert(context.analysisGaps.some((item) => item.code === "scope_envelope_unreliable"));
  assert.equal(context.quality.status, "partial");
  const unreferenced = buildResearchContext({ ...baseInput, scopeEnvelope: { ...baseInput.scopeEnvelope, basisSourceIds: [] } });
  assert.equal(unreferenced.scopeEnvelope, null);
  assert(unreferenced.analysisGaps.some((item) => item.code === "scope_envelope_unreliable"));
});

test("source registry deduplicates exact versions and preserves version changes", () => {
  const result = registerResearchSources([
    baseInput.sources[0],
    { ...baseInput.sources[0] },
    { ...baseInput.sources[0], contentFingerprint: "sha256:filing-revised" },
  ]);
  assert.equal(result.knownSourceIds.length, 2);
  assert.notEqual(result.knownSourceIds[0], result.knownSourceIds[1]);
  assert.equal(result.value.sources.length, 2);
});

test("missing identity and snapshots become visible gaps instead of model fallbacks", () => {
  const context = buildResearchContext({ ...baseInput, company: {}, security: {}, financialSnapshot: {}, marketSnapshot: {}, sources: [] });
  assert.equal(context.quality.status, "blocked");
  assert(context.analysisGaps.some((item) => item.code === "company_identity_missing"));
  assert(context.analysisGaps.some((item) => item.code === "security_identity_incomplete"));
  assert(context.analysisGaps.some((item) => item.code === "source_registry_empty"));
});
