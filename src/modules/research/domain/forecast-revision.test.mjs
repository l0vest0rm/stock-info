import assert from "node:assert/strict";
import test from "node:test";
import { buildForecastRevisionReadModel } from "./forecast-revision";

const base = {
  institution: "Alpha Research", forecastDate: "2026-01-01", metric: "revenue", fiscalYear: 2027, fiscalPeriod: "2027FY",
  currency: "CNY", normalizedUnit: "hundred_million_currency", normalizationStatus: "comparable", accountingBasis: "gaap",
  ownershipBasis: "consolidated", shareBasis: "unspecified", createdAt: 1, isCurrent: false,
  // Revision links are only created by the v4 write boundary after all of
  // these document-version provenance values have been frozen.  Keep the
  // read-model fixture representative instead of rebuilding a legacy v3
  // chain that production can no longer create.
  sourceIdentityAssertionId: "assertion:alpha-v1", originSourceIdentityId: "identity:alpha",
  carrierSourceIdentityId: "identity:alpha", carrierRelation: "original",
  modelLineageId: "lineage:alpha-core", independenceGroupId: "group:alpha",
};

test("builds an explicit source forecast version chain and comparable revision direction", () => {
  const result = buildForecastRevisionReadModel([
    { ...base, forecastId: "f1", supersedesForecastId: null, normalizedValue: 100 },
    { ...base, forecastId: "f2", supersedesForecastId: "f1", normalizedValue: 110, forecastDate: "2026-02-01", createdAt: 2 },
    { ...base, forecastId: "f3", supersedesForecastId: "f2", normalizedValue: 105, forecastDate: "2026-03-01", createdAt: 3, isCurrent: true },
  ]);
  assert.equal(result.label, "来源预测修订链");
  assert.equal(result.linkedForecastCount, 2);
  assert.equal(result.unlinkedForecastCount, 1);
  assert.deepEqual(result.chains[0].forecastIds, ["f1", "f2", "f3"]);
  assert.equal(result.chains[0].isCurrentLeaf, true);
  assert.equal(result.directions.find((item) => item.forecastId === "f2")?.direction, "upward");
  const final = result.directions.find((item) => item.forecastId === "f3");
  assert.equal(final?.direction, "downward");
  assert.equal(final?.absoluteChange, -5);
  assert.equal(final?.percentageChange, -0.045455);
});

test("does not calculate a direction when the predecessor is missing or the basis changes", () => {
  const result = buildForecastRevisionReadModel([
    { ...base, forecastId: "missing", supersedesForecastId: "gone", normalizedValue: 100 },
    { ...base, forecastId: "old", supersedesForecastId: null, normalizedValue: 100 },
    { ...base, forecastId: "changed", supersedesForecastId: "old", normalizedValue: 110, currency: "USD", forecastDate: "2026-02-01" },
  ]);
  assert.equal(result.directions.find((item) => item.forecastId === "missing")?.direction, "unavailable");
  assert.equal(result.directions.find((item) => item.forecastId === "missing")?.reasonCode, "superseded_forecast_not_available");
  assert.equal(result.directions.find((item) => item.forecastId === "changed")?.direction, "not_comparable");
  assert.equal(result.chains.find((item) => item.leafForecastId === "missing")?.branchStatus, "broken");
});

test("keeps a chain visible but marks normalization gaps for review rather than inventing a direction", () => {
  const result = buildForecastRevisionReadModel([
    { ...base, forecastId: "old", supersedesForecastId: null, normalizedValue: 100 },
    { ...base, forecastId: "new", supersedesForecastId: "old", normalizedValue: null, normalizationStatus: "needs_review", normalizedUnit: null },
  ]);
  assert.equal(result.directions[0].direction, "needs_review");
  assert.equal(result.directions[0].reasonCode, "normalization_needs_review");
});
