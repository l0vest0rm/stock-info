import assert from "node:assert/strict";
import test from "node:test";
import { buildResearchContext, normalizeScopeEnvelope, registerResearchSources } from "./research-context.ts";

const source = {
  url: "https://example.test/filing",
  title: "年报",
  publishedAt: "2026-04-01",
  subject: "测试公司",
  role: "formal_disclosure",
  retrievedAt: "2026-08-09T00:00:00.000Z",
  contentFingerprint: "sha256:filing",
  availabilityStatus: "available",
  limitations: [],
};
const base = {
  researchTaskId: "research-analysis:300308.SZ:2026-08-09T00:00:00.000Z",
  asOf: "2026-08-09T00:00:00.000Z",
  company: { companyId: "company:300308", name: "测试公司", reportingCurrency: "CNY" },
  security: { securityId: "security:300308.SZ", securityCode: "300308.SZ", listingVenue: "SZ", tradingCurrency: "CNY", shareClass: "A" },
  financialSnapshot: { asOf: "2026-08-09T00:00:00.000Z", schemaVersion: "financial-read-model.v1", source: "structured_financial", periods: [], incomeStatement: [], balanceSheet: [], cashFlowStatement: [], deterministicMetrics: [], qualityIssues: [] },
  marketSnapshot: { asOf: "2026-08-09T00:00:00.000Z", schemaVersion: "market-snapshot.v1", source: "xueqiu", securityId: "security:300308.SZ", securityCode: "300308.SZ", listingVenue: "SZ", shareClass: "A", tradingCurrency: "CNY", sharesOutstanding: 123, rights: { voting: "one_vote_per_share" }, historicalValuation: [{ asOf: "2026-03-31", metric: "pe_ttm", value: 22 }], periods: [], price: 10, marketCapitalization: 100, currency: "CNY", reportedMultiples: {}, qualityIssues: [] },
  scopeEnvelope: { products: ["产品"], customers: ["客户"], regions: ["中国"], uses: ["用途"], segments: [], uncertainBoundaries: ["未披露"], basisSourceIds: ["source:filing"] },
  sources: [source],
};

test("typed S0 context carries stable fingerprint, quality and source registry", async () => {
  const first = await buildResearchContext(base);
  const second = await buildResearchContext(structuredClone(base));
  assert.equal(first.inputFingerprint, second.inputFingerprint);
  assert.equal(first.contextVersion, "research-context.v1");
  assert.equal(first.quality.status, "available");
  assert.equal(first.marketSnapshot.sharesOutstanding, 123);
  assert.equal(first.marketSnapshot.rights?.voting, "one_vote_per_share");
  assert.equal(first.marketSnapshot.historicalValuation[0].metric, "pe_ttm");
  const revisedMarket = await buildResearchContext({ ...base, marketSnapshot: { ...base.marketSnapshot, sharesOutstanding: 124 } });
  assert.notEqual(first.inputFingerprint, revisedMarket.inputFingerprint);
  assert.equal(first.sourceRegistry.sources.length, 1);
  assert.equal("judgments" in first, false);
});

test("typed scope and source gates preserve explicit gaps", async () => {
  const scope = normalizeScopeEnvelope({ products: ["产品"], customers: [], regions: [], uses: [], segments: [], uncertainBoundaries: [] });
  assert.equal(scope.value, null);
  assert.equal(scope.analysisGaps[0].code, "scope_envelope_unreliable");
  const unreferenced = normalizeScopeEnvelope({ products: ["产品"], customers: ["客户"], regions: ["中国"], uses: ["用途"], segments: [], uncertainBoundaries: [], basisSourceIds: [] });
  assert.equal(unreferenced.value, null);
  const sources = await registerResearchSources([source, { ...source, contentFingerprint: "sha256:revised" }]);
  assert.equal(sources.knownSourceIds.length, 2);
  const blocked = await buildResearchContext({ ...base, company: {}, security: {}, sources: [] });
  assert.equal(blocked.quality.status, "blocked");
  assert(blocked.analysisGaps.some((item) => item.code === "source_registry_empty"));
});
