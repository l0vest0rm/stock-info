import assert from "node:assert/strict";
import test from "node:test";
import {
  createForecastActualCalibration,
  recordManagementGuidanceForecast,
  registerFormalActual,
} from "../application/forecast-actual-calibration";

const filing = [{ sourceKind: "filing", documentId: "filing:2027", url: "https://example.test/filing" }];
const actual = {
  actualId: "actual:1", securityCode: "300308.SZ", companyId: "company:1", metric: "revenue", fiscalYear: 2027,
  fiscalPeriod: "2027FY", rawValue: 12, rawUnit: "hundred_million_currency", currency: "CNY", accountingBasis: "gaap",
  ownershipBasis: "consolidated", shareBasis: "unspecified", filedAt: "2028-03-01", sourceStatement: "annual filing",
  sourceReferences: filing,
};

test("persists filing-backed formal actual without updating a historical fact", async () => {
  let inserted = null;
  const db = {
    prepare(sql) {
      return { bind(...values) {
        if (sql.includes("select actual_id as actualId from research_formal_actuals")) return { first: async () => null };
        if (sql.includes("insert into research_formal_actuals")) return { run: async () => { inserted = values; return { success: true }; } };
        throw new Error(`unexpected statement: ${sql}`);
      } };
    },
  };
  const saved = await registerFormalActual(db, actual, 100);
  assert.equal(saved.actualStatus, "original");
  assert.equal(saved.normalizedValue, 12);
  assert.equal(inserted.includes("observed_fact"), false);
  assert.equal(inserted.includes(JSON.stringify(filing)), true);
});

test("management guidance writer is independent of the third-party source forecast table", async () => {
  let statement = "";
  const db = { prepare(sql) { statement = sql; return { bind: () => ({ run: async () => ({ success: true }) }) }; } };
  const saved = await recordManagementGuidanceForecast(db, {
    guidanceForecastId: "guidance:1", securityCode: "300308.SZ", companyId: "company:1", guidanceDate: "2026-08-30",
    metric: "revenue", fiscalYear: 2027, fiscalPeriod: "2027FY", rawValue: 12, rawUnit: "hundred_million_currency",
    currency: "CNY", accountingBasis: "gaap", ownershipBasis: "consolidated", shareBasis: "unspecified",
    guidanceConditions: "demand normal", sourceStatement: "earnings release", sourceReferences: filing,
  }, 100);
  assert.match(statement, /research_management_guidance_forecasts/);
  assert.equal(saved.forecastKind, "management_guidance");
});

test("management guidance supersession must name an earlier guidance record for the same security", async () => {
  const db = {
    prepare(sql) {
      return { bind: () => {
        if (sql.includes("from research_management_guidance_forecasts")) return { first: async () => null };
        throw new Error(`unexpected statement: ${sql}`);
      } };
    },
  };
  await assert.rejects(() => recordManagementGuidanceForecast(db, {
    guidanceForecastId: "guidance:new", securityCode: "300308.SZ", companyId: "company:1", guidanceDate: "2026-09-01",
    metric: "revenue", fiscalYear: 2027, fiscalPeriod: "2027FY", rawValue: 12, rawUnit: "hundred_million_currency",
    currency: "CNY", accountingBasis: "gaap", ownershipBasis: "consolidated", shareBasis: "unspecified",
    guidanceConditions: "demand normal", sourceStatement: "earnings release", sourceReferences: filing,
    supersedesGuidanceForecastId: "guidance:other-security",
  }, 100), /supersedesGuidanceForecastId must identify management guidance for this security/);
});

test("persists a visible blocked calibration for restated actuals instead of manufacturing an error statistic", async () => {
  let bound = null;
  const db = {
    prepare(sql) {
      return { bind(...values) {
        if (sql.includes("from research_source_forecasts")) return { first: async () => ({
          forecastId: "forecast:1", securityCode: "300308.SZ", companyId: "company:1", forecastDate: "2026-09-01",
          metric: "revenue", fiscalYear: 2027, fiscalPeriod: "2027FY", rawValue: 10, rawUnit: "hundred_million_currency",
          currency: "CNY", accountingBasis: "gaap", ownershipBasis: "consolidated", shareBasis: "unspecified",
          normalizedValue: 10, normalizedUnit: "hundred_million_currency", normalizationStatus: "comparable", normalizationNotes: null,
        }) };
        if (sql.includes("from research_formal_actuals")) return { first: async () => ({
          actualId: "actual:2", securityCode: "300308.SZ", companyId: "company:1", metric: "revenue", fiscalYear: 2027,
          fiscalPeriod: "2027FY", rawValue: 12, rawUnit: "hundred_million_currency", currency: "CNY", accountingBasis: "gaap",
          ownershipBasis: "consolidated", shareBasis: "unspecified", normalizedValue: 12, normalizedUnit: "hundred_million_currency",
          normalizationStatus: "comparable", normalizationNotes: null, actualStatus: "restated", revisionNumber: 2,
          supersedesActualId: "actual:1", restatementNote: "restated", filedAt: "2028-04-01", sourceStatement: "amended filing", sourceReferencesJson: JSON.stringify(filing),
        }) };
        if (sql.includes("insert into research_forecast_actual_calibration_records")) return { run: async () => { bound = values; return { success: true }; } };
        throw new Error(`unexpected statement: ${sql}`);
      } };
    },
  };
  const saved = await createForecastActualCalibration(db, {
    calibrationId: "calibration:1", securityCode: "300308.SZ", forecastKind: "third_party_forecast", forecastId: "forecast:1", actualId: "actual:2", calibratedAt: 100,
  });
  assert.equal(saved.comparabilityStatus, "not_comparable");
  assert.equal(saved.comparabilityReason, "actual_restatement");
  assert.equal(bound.includes("actual_restatement"), true);
  assert.equal(bound.includes(null), true);
});
