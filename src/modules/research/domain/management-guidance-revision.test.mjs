import assert from "node:assert/strict";
import test from "node:test";
import { buildManagementGuidanceRevisionReadModel } from "./management-guidance-revision";

const base = {
  forecastDate: "2026-01-01", metric: "revenue", fiscalYear: 2027, fiscalPeriod: "2027FY",
  currency: "CNY", normalizedUnit: "hundred_million_currency", normalizationStatus: "comparable",
  accountingBasis: "gaap", ownershipBasis: "consolidated", shareBasis: "unspecified",
};

test("builds a management-guidance revision chain only from explicit supersession links", () => {
  const result = buildManagementGuidanceRevisionReadModel([
    { ...base, forecastId: "g1", supersedesGuidanceForecastId: null, normalizedValue: 100 },
    { ...base, forecastId: "g2", supersedesGuidanceForecastId: "g1", normalizedValue: 110, forecastDate: "2026-02-01" },
    { ...base, forecastId: "g3", supersedesGuidanceForecastId: "g2", normalizedValue: 105, forecastDate: "2026-03-01" },
    { ...base, forecastId: "same-value", supersedesGuidanceForecastId: null, normalizedValue: 105, forecastDate: "2026-03-01" },
  ]);
  assert.equal(result.label, "管理层指引修订链");
  assert.equal(result.ruleVersion, "management-guidance-revision.v1");
  assert.equal(result.linkedGuidanceCount, 2);
  assert.equal(result.unlinkedGuidanceCount, 2);
  assert.deepEqual(result.chains.find((item) => item.leafForecastId === "g3")?.forecastIds, ["g1", "g2", "g3"]);
  assert.equal(result.directions.find((item) => item.forecastId === "g2")?.direction, "upward");
  assert.equal(result.directions.find((item) => item.forecastId === "g3")?.direction, "downward");
  assert.equal(result.directions.some((item) => item.forecastId === "same-value"), false);
});

test("blocks a direction when the previous guidance is absent, unnormalized, or changes basis", () => {
  const result = buildManagementGuidanceRevisionReadModel([
    { ...base, forecastId: "missing", supersedesGuidanceForecastId: "gone", normalizedValue: 100 },
    { ...base, forecastId: "old", supersedesGuidanceForecastId: null, normalizedValue: 100 },
    { ...base, forecastId: "changed", supersedesGuidanceForecastId: "old", normalizedValue: 110, currency: "USD", forecastDate: "2026-02-01" },
    { ...base, forecastId: "review", supersedesGuidanceForecastId: "old", normalizedValue: null, normalizedUnit: null, normalizationStatus: "needs_review", forecastDate: "2026-03-01" },
  ]);
  assert.equal(result.directions.find((item) => item.forecastId === "missing")?.direction, "unavailable");
  assert.equal(result.directions.find((item) => item.forecastId === "missing")?.reasonCode, "superseded_guidance_not_available");
  assert.equal(result.directions.find((item) => item.forecastId === "changed")?.direction, "not_comparable");
  assert.equal(result.directions.find((item) => item.forecastId === "review")?.direction, "needs_review");
  assert.equal(result.chains.find((item) => item.leafForecastId === "missing")?.branchStatus, "broken");
  assert.equal(result.chains.find((item) => item.leafForecastId === "changed")?.branchStatus, "branched");
});
