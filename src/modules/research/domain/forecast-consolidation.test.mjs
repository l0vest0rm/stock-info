import assert from "node:assert/strict";
import test from "node:test";
import { assertForecastSupersedesSameModelLineage, buildForecastConsolidation, normalizeSourceForecast } from "./forecast-consolidation";

const base = {
  metric: "net_profit",
  fiscalYear: 2027,
  rawUnit: "hundred_million_currency",
  currency: "CNY",
  accountingBasis: "gaap",
  ownershipBasis: "attributable_to_parent",
  shareBasis: "unspecified",
  sourceIdentityId: "source-identity:alpha",
  sourceIdentityAssertionId: "source-assertion:alpha",
  originSourceIdentityId: "source-identity:alpha",
  carrierSourceIdentityId: "source-identity:alpha",
  carrierRelation: "original",
  modelLineageId: "model-lineage:alpha-core",
  independenceGroupId: "source-group:alpha",
  createdAt: 1,
};

test("normalizes amount scales without guessing a missing currency", () => {
  const normalized = normalizeSourceForecast({ ...base, forecastId: "f1", institution: "A", forecastDate: "2026-01-01", rawValue: 1250, rawUnit: "million_currency" });
  assert.equal(normalized.normalizedValue, 12.5);
  assert.equal(normalized.normalizedUnit, "hundred_million_currency");
  assert.equal(normalized.normalizationStatus, "comparable");

  const missingCurrency = normalizeSourceForecast({ ...base, forecastId: "f2", institution: "A", forecastDate: "2026-01-01", rawValue: 12, currency: null });
  assert.equal(missingCurrency.normalizationStatus, "needs_review");
  assert.equal(missingCurrency.normalizationNotes, "currency_required_for_amount");
});

test("keeps unresolved accounting, profit ownership, and EPS share bases out of comparable samples", () => {
  const unknownAccounting = normalizeSourceForecast({
    ...base, forecastId: "unknown-accounting", institution: "A", forecastDate: "2026-01-01",
    rawValue: 12, accountingBasis: "unspecified",
  });
  assert.equal(unknownAccounting.normalizationStatus, "needs_review");
  assert.equal(unknownAccounting.normalizationNotes, "accounting_basis_required");

  const unknownOwnership = normalizeSourceForecast({
    ...base, forecastId: "unknown-ownership", institution: "A", forecastDate: "2026-01-01",
    rawValue: 12, ownershipBasis: "unspecified",
  });
  assert.equal(unknownOwnership.normalizationNotes, "ownership_basis_required_for_profit");

  const unknownShareBasis = normalizeSourceForecast({
    ...base, forecastId: "unknown-share", institution: "A", forecastDate: "2026-01-01",
    metric: "eps", rawValue: 1.2, rawUnit: "currency_per_share", ownershipBasis: "unspecified",
    shareBasis: "unspecified",
  });
  assert.equal(unknownShareBasis.normalizationNotes, "share_basis_required_for_eps");
});

test("keeps only the latest forecast from one confirmed independence-group/model lineage and never calls the sample consensus", () => {
  const result = buildForecastConsolidation([
    { ...base, forecastId: "a-old", institution: "Alpha Research", forecastDate: "2026-01-01", rawValue: 10 },
    { ...base, forecastId: "a-new", institution: " alpha   research ", forecastDate: "2026-02-01", rawValue: 12, createdAt: 2 },
    { ...base, forecastId: "later-alpha", institution: "Alpha Research", forecastDate: "2026-02-02", rawValue: 13, createdAt: 3 },
    { ...base, forecastId: "b", institution: "Beta", sourceIdentityId: "source-identity:beta", sourceIdentityAssertionId: "source-assertion:beta", originSourceIdentityId: "source-identity:beta", carrierSourceIdentityId: "source-identity:beta", modelLineageId: "model-lineage:beta-core", independenceGroupId: "source-group:beta", forecastDate: "2026-01-20", rawValue: 18 },
  ]);
  assert.equal(result.label, "已纳入样本的预测汇总");
  assert.equal(result.marketConsensus, false);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0], {
    comparisonKey: "net_profit|2027|CNY|hundred_million_currency|gaap|attributable_to_parent|unspecified",
    metric: "net_profit",
    fiscalYear: 2027,
    currency: "CNY",
    normalizedUnit: "hundred_million_currency",
    accountingBasis: "gaap",
    ownershipBasis: "attributable_to_parent",
    shareBasis: "unspecified",
    sampleCount: 2,
    medianValue: 15.5,
    meanValue: 15.5,
    minValue: 13,
    maxValue: 18,
    standardDeviation: 2.5,
  });
  assert.equal(result.members.find((item) => item.forecastId === "a-old")?.reasonCode, "superseded_by_latest_independence_group_model_forecast");
  assert.equal(result.members.find((item) => item.forecastId === "a-new")?.reasonCode, "superseded_by_latest_independence_group_model_forecast");
  assert.equal(result.members.find((item) => item.forecastId === "later-alpha")?.reasonCode, "included");
});

test("excludes forecasts without a reviewed document-version assertion and keeps incompatible accounting bases separate", () => {
  const result = buildForecastConsolidation([
    { ...base, forecastId: "unknown", institution: "Unverified label", sourceIdentityId: null, sourceIdentityAssertionId: null, originSourceIdentityId: null, carrierSourceIdentityId: null, carrierRelation: null, modelLineageId: null, independenceGroupId: null, forecastDate: "2026-01-01", rawValue: 10 },
    { ...base, forecastId: "gaap", institution: "A", forecastDate: "2026-01-01", rawValue: 12 },
    { ...base, forecastId: "adjusted", institution: "B", sourceIdentityId: "source-identity:b", sourceIdentityAssertionId: "source-assertion:b", originSourceIdentityId: "source-identity:b", carrierSourceIdentityId: "source-identity:b", modelLineageId: "model-lineage:b-core", independenceGroupId: "source-group:b", forecastDate: "2026-01-01", rawValue: 14, accountingBasis: "adjusted" },
  ]);
  assert.equal(result.groups.length, 2);
  assert.equal(result.members.find((item) => item.forecastId === "unknown")?.reasonCode, "source_identity_assertion_unresolved");
});

test("excludes republication, shared carriers and unknown origin assertions without letting them inflate a source sample", () => {
  const relation = (forecastId, carrierRelation) => ({ ...base, forecastId, sourceIdentityAssertionId: `assertion:${forecastId}`,
    carrierSourceIdentityId: `carrier:${forecastId}`, carrierRelation, forecastDate: "2026-01-01", rawValue: 10 });
  const result = buildForecastConsolidation([
    relation("republication", "republication"), relation("shared", "shared"),
    { ...relation("unknown", "unknown"), originSourceIdentityId: null, modelLineageId: null, independenceGroupId: null },
  ]);
  assert.equal(result.groups.length, 0);
  assert.equal(result.members.find((item) => item.forecastId === "republication")?.reasonCode, "source_republication");
  assert.equal(result.members.find((item) => item.forecastId === "shared")?.reasonCode, "source_shared_authorship");
  assert.equal(result.members.find((item) => item.forecastId === "unknown")?.reasonCode, "source_carrier_unknown");
});

test("keeps distinct reviewed model lineages from one origin group while deduplicating each lineage", () => {
  const result = buildForecastConsolidation([
    { ...base, forecastId: "core-old", forecastDate: "2026-01-01", rawValue: 10 },
    { ...base, forecastId: "core-new", forecastDate: "2026-02-01", rawValue: 12, createdAt: 2 },
    { ...base, forecastId: "sector-model", sourceIdentityAssertionId: "source-assertion:alpha-sector", modelLineageId: "model-lineage:alpha-sector", forecastDate: "2026-01-15", rawValue: 20 },
  ]);
  assert.equal(result.groups[0].sampleCount, 2);
  assert.equal(result.members.find((item) => item.forecastId === "core-old")?.reasonCode, "superseded_by_latest_independence_group_model_forecast");
  assert.equal(result.members.find((item) => item.forecastId === "core-new")?.reasonCode, "included");
  assert.equal(result.members.find((item) => item.forecastId === "sector-model")?.reasonCode, "included");
});

test("a source-forecast revision cannot silently cross an explicit model lineage", () => {
  assert.doesNotThrow(() => assertForecastSupersedesSameModelLineage("model-lineage:alpha-core", "model-lineage:alpha-core"));
  assert.throws(() => assertForecastSupersedesSameModelLineage("model-lineage:alpha-core", "model-lineage:alpha-sector"), /same explicit model lineage/);
  assert.throws(() => assertForecastSupersedesSameModelLineage(null, "model-lineage:alpha-core"), /same explicit model lineage/);
});
