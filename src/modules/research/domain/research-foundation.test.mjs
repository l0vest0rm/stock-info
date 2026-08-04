import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDerivedObservation,
  buildForecastCalibration,
  buildForecastConsolidation,
  buildResearchCompletion,
} from "./research-foundation.ts";

const requirement = (id, status, blocking = true, requiredAt = "basic") => ({ id, label: id, status, blocking, requiredAt, effect: `${id} effect`, nextStep: `${id} next` });

test("research completion honors object, missing, conflict, stale precedence without an averaged score", () => {
  const result = buildResearchCompletion({ coverageLevel: "standard", requirements: [
    requirement("identity", "object_mismatch"),
    requirement("financials", "missing"),
    requirement("forecast", "conflicting"),
    requirement("market", "stale"),
  ] });
  assert.equal(result.state, "object_mismatch");
  assert.equal(result.gaps.length, 4);
  assert.equal("completionPct" in result, false);
});

test("research completion blocks standard research on its own required facts", () => {
  const result = buildResearchCompletion({ coverageLevel: "standard", requirements: [
    requirement("basic", "available", true, "basic"),
    requirement("forecast", "missing", true, "standard"),
    requirement("deep-only", "missing", true, "deep"),
  ] });
  assert.equal(result.state, "blocked");
  assert.deepEqual(result.gaps.map((item) => item.id), ["forecast"]);
});

test("derived observations stay unavailable when a cited input or formula is missing", () => {
  const observation = buildDerivedObservation({ id: "fcf-margin", label: "FCF margin", formula: "FCF / revenue", unit: "%", asOf: 10,
    value: 0.2, sourceFacts: [{ id: "fcf", label: "FCF", value: 20, asOf: 10, sourceIds: ["cashflow"] }, { id: "revenue", label: "Revenue", value: null, asOf: 10, sourceIds: ["income"] }], adjustments: [] });
  assert.equal(observation.state, "unavailable");
  assert.equal(observation.value, null);
  assert.deepEqual(observation.missingInputIds, ["revenue"]);
});

test("forecast consolidation deduplicates publishers and does not invent consensus", () => {
  const base = { companyId: "NVDA", metric: "net_income", fiscalPeriod: "FY2027", accountingBasis: "GAAP", currency: "USD", unit: "million", kind: "third_party_forecast", sourceUrl: "https://example.test/report" };
  const result = buildForecastConsolidation({ ...base, asOf: 100, forecasts: [
    { ...base, id: "old", publisher: "Firm A", sourceId: "a-old", value: 90, publishedAt: 50 },
    { ...base, id: "new", publisher: "Firm A", sourceId: "a-new", value: 110, publishedAt: 80 },
    { ...base, id: "b", publisher: "Firm B", sourceId: "b", value: 100, publishedAt: 70 },
    { ...base, id: "guidance", publisher: "Issuer", sourceId: "issuer", value: 999, publishedAt: 60, kind: "management_guidance" },
  ] });
  assert.equal(result.state, "included_sample");
  assert.equal(result.label, "已纳入样本预测汇总");
  assert.equal(result.marketConsensus.eligible, false);
  assert.deepEqual(result.included.map((item) => item.id), ["new", "b"]);
  assert.deepEqual(result.statistics, { count: 2, median: 105, mean: 105, min: 100, max: 110, range: 10 });
  assert.ok(result.exclusions.some((item) => item.forecastId === "guidance" && item.reason === "management_guidance_is_not_third_party_forecast"));
});

test("forecast calibration refuses a silently changed accounting basis", () => {
  const forecast = { id: "f1", publisher: "Firm", sourceId: "firm-1", sourceUrl: "https://example.test", companyId: "X", metric: "eps", fiscalPeriod: "FY2027", accountingBasis: "non-GAAP", currency: "USD", unit: "USD/share", value: 10, publishedAt: 10, kind: "third_party_forecast" };
  const actual = { id: "a1", label: "EPS", value: 8, asOf: 20, sourceIds: ["filing"] };
  const result = buildForecastCalibration({ forecast, actual, accountingBasis: "GAAP", actualAccountingBasis: "GAAP", metric: "eps", actualMetric: "eps", fiscalPeriod: "FY2027", actualFiscalPeriod: "FY2027" });
  assert.equal(result.state, "not_comparable");
  assert.equal(result.absoluteError, null);
});
