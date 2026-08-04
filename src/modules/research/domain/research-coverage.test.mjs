import assert from "node:assert/strict";
import test from "node:test";
import { buildResearchCoverage } from "./research-coverage";
import { buildForecastCoverageReadModel } from "./forecast-coverage";

const unavailableForecastCoverage = buildForecastCoverageReadModel({});

test("coverage keeps blocked finance and pending valuation review explicit", () => {
  const coverage = buildResearchCoverage({ identity: { operatingCompany: {}, listedSecurity: { mappingStatus: "confirmed" } }, financials: { availability: "available", statutoryGate: { status: "pending" } }, marketStructure: { availability: "available", perShareValuation: { status: "ready" } }, operating: {}, industry: {}, forecast: unavailableForecastCoverage, valuation: { availability: "available", items: [{}] }, reverseValuation: { availability: "empty", items: [] }, risk: { availability: "empty", items: [] }, theses: { availability: "empty", items: [] }, modelReviewItems: [{ state: "open" }], market: {} });
  assert.equal(coverage.modules.find((item) => item.moduleId === "financials").status, "partial");
  assert.equal(coverage.modules.find((item) => item.moduleId === "valuation").status, "blocked");
  assert.equal(coverage.modules.find((item) => item.moduleId === "forecasts").status, "unavailable");
});

test("saved valuation cannot bypass the current per-security share and rights gate", () => {
  const coverage = buildResearchCoverage({ identity: { operatingCompany: {}, listedSecurity: { mappingStatus: "confirmed" } }, financials: { availability: "available", statutoryGate: { status: "verified" } }, marketStructure: { availability: "available", perShareValuation: { status: "blocked", reason: "missing basic_shares, diluted_shares" } }, operating: {}, industry: {}, forecast: unavailableForecastCoverage, valuation: { availability: "available", items: [{}] }, reverseValuation: { availability: "empty", items: [] }, risk: { availability: "empty", items: [] }, theses: { availability: "empty", items: [] }, modelReviewItems: [], market: {} });
  const valuation = coverage.modules.find((item) => item.moduleId === "valuation");
  assert.equal(valuation.status, "blocked");
  assert.match(valuation.conclusionImpact, /精确每股价值/);
  assert.match(valuation.nextEvidence, /basic_shares/);
});

test("competition and market observation remain independent from operating-model coverage", () => {
  const coverage = buildResearchCoverage({
    identity: { operatingCompany: {}, listedSecurity: { mappingStatus: "confirmed" } },
    financials: { availability: "available", statutoryGate: { status: "verified" } },
    marketStructure: { availability: "available", perShareValuation: { status: "ready" } },
    operating: { models: { availability: "available", items: [{}] }, driverPlans: { availability: "available", items: [{}] }, marketSpaceAssessments: { availability: "available", items: [{}] } },
    industry: { exposures: { availability: "available", items: [{}] }, peerSets: { availability: "empty", items: [] }, competitiveMarkets: { availability: "empty", items: [] } },
    forecast: unavailableForecastCoverage, valuation: { availability: "empty", items: [] }, reverseValuation: { availability: "empty", items: [] },
    risk: { availability: "empty", items: [] }, theses: { availability: "empty", items: [] }, modelReviewItems: [],
    market: { rows: 120, source: "xueqiu", latestDate: "2026-08-05" },
  });
  assert.equal(coverage.modules.find((item) => item.moduleId === "operating")?.status, "ready");
  assert.equal(coverage.modules.find((item) => item.moduleId === "industry_competition")?.status, "partial");
  assert.equal(coverage.modules.find((item) => item.moduleId === "market_state")?.status, "partial");
  assert.match(coverage.modules.find((item) => item.moduleId === "industry_competition")?.conclusionImpact ?? "", /不能形成竞争位置/);
});
