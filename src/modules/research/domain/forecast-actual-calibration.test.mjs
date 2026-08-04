import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateForecastActualCalibration,
  formalActualCalibrationLayerStatus,
  normalizeFormalActual,
  normalizeManagementGuidanceForecast,
} from "./forecast-actual-calibration";

const filing = [{ sourceKind: "filing", documentId: "filing:2027-annual", url: "https://example.test/annual" }];
const actualInput = {
  actualId: "actual:2027:revenue:v1", securityCode: "300308.SZ", companyId: "company:1", metric: "revenue",
  fiscalYear: 2027, fiscalPeriod: "2027FY", rawValue: 1200, rawUnit: "million_currency", currency: "CNY",
  accountingBasis: "gaap", ownershipBasis: "consolidated", shareBasis: "unspecified", filedAt: "2028-03-01",
  sourceStatement: "2027 annual-report revenue", sourceReferences: filing, actualStatus: "original", revisionNumber: 1,
};

const thirdPartyForecast = {
  forecastKind: "third_party_forecast", forecastId: "forecast:broker:2027", securityCode: "300308.SZ", companyId: "company:1",
  forecastDate: "2026-09-01", metric: "revenue", fiscalYear: 2027, fiscalPeriod: "2027FY", rawValue: 10,
  rawUnit: "hundred_million_currency", currency: "CNY", accountingBasis: "gaap", ownershipBasis: "consolidated",
  shareBasis: "unspecified", normalizedValue: 10, normalizedUnit: "hundred_million_currency",
  normalizationStatus: "comparable", normalizationNotes: null,
};

test("filing-backed formal actual normalizes independently and carries observed-fact identity", () => {
  const actual = normalizeFormalActual(actualInput);
  assert.equal(actual.epistemicType, "observed_fact");
  assert.equal(actual.normalizedValue, 12);
  assert.equal(actual.normalizedUnit, "hundred_million_currency");
  assert.equal(actual.actualStatus, "original");
});

test("management guidance remains a separate forecast kind while using the shared comparison basis", () => {
  const guidance = normalizeManagementGuidanceForecast({
    guidanceForecastId: "guidance:1", securityCode: "300308.SZ", companyId: "company:1", guidanceDate: "2026-08-30",
    metric: "revenue", fiscalYear: 2027, fiscalPeriod: "2027FY", rawValue: 11, rawUnit: "hundred_million_currency",
    currency: "CNY", accountingBasis: "gaap", ownershipBasis: "consolidated", shareBasis: "unspecified",
    guidanceConditions: "subject to demand", sourceStatement: "management guidance", sourceReferences: filing,
  });
  assert.equal(guidance.forecastKind, "management_guidance");
  assert.equal(guidance.epistemicType, "management_guidance");
  assert.equal(guidance.normalizationStatus, "comparable");
});

test("only identical period, currency, unit and bases produce an error statistic", () => {
  const actual = normalizeFormalActual(actualInput);
  const result = evaluateForecastActualCalibration(thirdPartyForecast, actual);
  assert.equal(result.comparabilityStatus, "comparable");
  assert.equal(result.absoluteError, 2);
  assert.equal(result.percentageError, 0.2);

  const wrongCurrency = evaluateForecastActualCalibration({ ...thirdPartyForecast, currency: "USD" }, actual);
  assert.equal(wrongCurrency.comparabilityStatus, "not_comparable");
  assert.equal(wrongCurrency.comparabilityReason, "currency_mismatch");
});

test("restated actuals and actuals without filing evidence never create a comparable calibration", () => {
  const restated = normalizeFormalActual({
    ...actualInput, actualId: "actual:2027:revenue:v2", actualStatus: "restated", revisionNumber: 2,
    supersedesActualId: "actual:2027:revenue:v1", restatementNote: "business combination restatement",
  });
  const result = evaluateForecastActualCalibration(thirdPartyForecast, restated);
  assert.equal(result.comparabilityStatus, "not_comparable");
  assert.equal(result.comparabilityReason, "actual_restatement");
  assert.throws(() => normalizeFormalActual({ ...actualInput, sourceReferences: [{ sourceKind: "external_url", url: "https://example.test" }] }), /filing source reference/);
});

test("forecast workspace calibration status distinguishes a usable calibration from an audited block", () => {
  assert.equal(formalActualCalibrationLayerStatus([]), "unavailable");
  assert.equal(formalActualCalibrationLayerStatus([{ comparabilityStatus: "not_comparable" }]), "partial");
  assert.equal(formalActualCalibrationLayerStatus([
    { comparabilityStatus: "not_comparable" },
    { comparabilityStatus: "comparable" },
  ]), "available");
});
