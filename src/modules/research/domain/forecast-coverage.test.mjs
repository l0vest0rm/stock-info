import assert from "node:assert/strict";
import test from "node:test";
import { buildForecastCoverageReadModel } from "./forecast-coverage";
import { buildResearchCoverage } from "./research-coverage";

const baseCoverageInput = (forecast) => ({
  identity: { operatingCompany: {}, listedSecurity: { mappingStatus: "confirmed" } },
  financials: { availability: "available", statutoryGate: { status: "verified" } },
  marketStructure: { availability: "available", perShareValuation: { status: "ready" } },
  operating: {}, industry: {}, forecast,
  valuation: { availability: "empty", items: [] }, reverseValuation: { availability: "empty", items: [] },
  risk: { availability: "empty", items: [] }, theses: { availability: "empty", items: [] }, modelReviewItems: [], market: {},
});

const original = {
  forecastId: "forecast:original", sourceIdentityAssertionId: "assertion:1", originSourceIdentityId: "origin:1",
  carrierSourceIdentityId: "carrier:1", carrierRelation: "original", modelLineageId: "lineage:1",
  independenceGroupId: "group:1", normalizationStatus: "comparable", createdAt: 100,
};

test("ordinary documents and unreviewed candidates do not make forecast coverage partial", () => {
  const noV4Review = buildForecastCoverageReadModel({
    sourceCandidates: [{ informationId: "information:ordinary-report", reviewStatus: null }],
  });
  assert.equal(noV4Review.status, "blocked");
  assert.deepEqual(noV4Review.counts, {
    candidates: 1, reviewed: 0, pending: 1, reviewExcluded: 0, originalEligible: 0, included: 0, excluded: 0,
  });
  const coverage = buildResearchCoverage(baseCoverageInput(noV4Review));
  assert.equal(coverage.modules.find((item) => item.moduleId === "forecasts")?.status, "blocked");
  assert.doesNotMatch(coverage.modules.find((item) => item.moduleId === "forecasts")?.conclusionImpact ?? "", /市场一致预期/);
});

test("only a reviewed original independent v4 member can make forecast coverage ready", () => {
  const forecast = buildForecastCoverageReadModel({
    sourceCandidates: [
      { informationId: "information:original", reviewStatus: "included", reviewedAt: 100 },
      { informationId: "information:pending", reviewStatus: "needs_review", reviewedAt: 101 },
    ],
    sourceForecasts: [original],
    consolidation: {
      consolidationId: "consolidation:v4", asOf: 102, label: "已纳入样本的预测汇总", ruleVersion: "forecast-consolidation.v4",
      marketConsensus: false,
      members: [
        { forecastId: "forecast:original", membershipStatus: "included", reasonCode: "included" },
        { forecastId: "forecast:copy", membershipStatus: "excluded", reasonCode: "source_republication" },
      ],
    },
    consolidationStatus: { availability: "available", reason: null },
  });
  assert.equal(forecast.status, "ready");
  assert.equal(forecast.consolidation.label, "已纳入样本的预测汇总");
  assert.equal(forecast.marketConsensus, false);
  assert.deepEqual(forecast.counts, {
    candidates: 2, reviewed: 1, pending: 1, reviewExcluded: 0, originalEligible: 1, included: 1, excluded: 1,
  });
  const coverage = buildResearchCoverage(baseCoverageInput(forecast));
  const module = coverage.modules.find((item) => item.moduleId === "forecasts");
  assert.equal(module?.status, "ready");
  assert.match(module?.conclusionImpact ?? "", /已纳入样本的预测汇总/);
  assert.match(module?.conclusionImpact ?? "", /绝非市场一致预期/);
});

test("a reviewed republished or incomplete source remains blocked rather than partial", () => {
  const forecast = buildForecastCoverageReadModel({
    sourceCandidates: [{ informationId: "information:copy", reviewStatus: "included", reviewedAt: 100 }],
    sourceForecasts: [{ ...original, forecastId: "forecast:copy", carrierRelation: "republication" }],
    consolidationStatus: { availability: "empty", reason: null },
  });
  assert.equal(forecast.status, "blocked");
  assert.equal(forecast.counts.originalEligible, 0);
  assert.equal(buildResearchCoverage(baseCoverageInput(forecast)).modules.find((item) => item.moduleId === "forecasts")?.status, "blocked");
});
