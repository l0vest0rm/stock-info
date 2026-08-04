import assert from "node:assert/strict";
import test from "node:test";
import { buildDcfValuationInputFromOperatingScenario, buildDcfValuationInputFromOperatingScenarioWithFormalActualAnchors, projectOperatingScenarioForValuation } from "../application/operating-scenario-valuation";
import { normalizeFormalActual } from "./forecast-actual-calibration";
import { buildDcfValuationModelVersion } from "./valuation-model-version";

const sourceReferences = [{ sourceKind: "filing", documentId: "filing:2026-annual", url: "https://example.test/2026-annual" }];
const scenario = {
  scenarioId: "forecast-scenario:base:4",
  scenarioName: "base",
  version: 4,
  asOf: 100,
  valuationCurrency: "CNY",
  amountScale: "CNY million",
  openingRevenue: 100,
  openingNetWorkingCapital: 10,
  sourceReferences,
  valuation: {
    wacc: 0.1, terminalGrowth: 0.03, netDebtAtValuation: 12, dilutedShares: 50,
    sourceReferences,
    netDebtSourceReferences: sourceReferences,
    dilutedSharesSourceReferences: sourceReferences,
  },
  years: [
    { fiscalYear: 2027, revenueGrowth: 0.1, ebitMargin: 0.2, taxRate: 0.25, depreciationAmortizationMargin: 0.04, capitalExpenditureMargin: 0.06, netWorkingCapitalToRevenue: 0.12, forecastNetDebt: 40, sourceReferences },
    { fiscalYear: 2028, revenueGrowth: 0.2, ebitMargin: 0.22, taxRate: 0.25, depreciationAmortizationMargin: 0.04, capitalExpenditureMargin: 0.07, netWorkingCapitalToRevenue: 0.12, forecastNetDebt: 35, sourceReferences },
  ],
};

test("self-built operating scenario deterministically derives annual revenue, profit, cash flow, NWC and debt outputs", () => {
  const projection = projectOperatingScenarioForValuation(scenario);
  assert.equal(projection.scenarioVersion, 4);
  approximately(projection.annuals[0].revenue, 110);
  approximately(projection.annuals[0].ebit, 22);
  approximately(projection.annuals[0].nopat, 16.5);
  approximately(projection.annuals[0].endingNetWorkingCapital, 13.2);
  approximately(projection.annuals[0].changeInNetWorkingCapital, 3.2);
  approximately(projection.annuals[0].unleveredFreeCashFlow, 11.1);
  approximately(projection.annuals[1].revenue, 132);
  assert.equal(projection.annuals[1].forecastNetDebt, 35);
  approximately(projection.operatingForecasts[0].changeInNetWorkingCapital, 3.2);
});

test("scenario projection compiles into the existing immutable DCF contract without treating forecast debt as as-of debt", () => {
  const input = buildDcfValuationInputFromOperatingScenario(scenario, {
    modelVersionId: "dcf:scenario:1", companyId: "company:1", securityCode: "300308.SZ",
    securityCurrency: "CNY", fxRateToSecurity: null, fxAsOf: null, fxSourceReferences: [], underlyingSharesPerSecurity: 1,
  });
  assert.equal(input.inputs.find((item) => item.key === "net_debt")?.value, 12);
  assert.equal(input.inputs.find((item) => item.key === "fy2028_forecast_net_debt")?.value, 35);
  assert.equal(input.inputs.find((item) => item.key === "net_debt")?.epistemicType, "observed_fact");
  assert.equal(input.inputs.find((item) => item.key === "diluted_shares")?.epistemicType, "observed_fact");
  assert.equal(input.inputs.filter((item) => !["net_debt", "diluted_shares"].includes(item.key)).every((item) => item.epistemicType === "analysis_assumption"), true);
  assert.equal(input.operatingForecasts.length, 2);
  assert.deepEqual(input.sourceReferences.find((item) => item.sourceKind === "research_record"), {
    sourceKind: "research_record", sourceId: "forecast-scenario:base:4", title: "Self-built operating scenario: base v4", publishedAt: 100,
  });
  const model = buildDcfValuationModelVersion(input);
  assert.equal(model.securityCode, "300308.SZ");
  assert.equal(model.inputs.find((item) => item.key === "scenario_version")?.value, 4);
  approximately(model.result.forecastYears[0].unleveredFreeCashFlow, 11.1);
});

test("scenario validation rejects an impossible revenue path and nonconsecutive fiscal years", () => {
  assert.throws(() => projectOperatingScenarioForValuation({ ...scenario, years: [{ ...scenario.years[0], revenueGrowth: -1 }] }), /greater than -100%/);
  assert.throws(() => projectOperatingScenarioForValuation({ ...scenario, years: [scenario.years[0], { ...scenario.years[1], fiscalYear: 2029 }] }), /consecutive/);
});

test("filing-backed actual adds an observed anchor without overwriting the self-built opening assumption", () => {
  const actual = formalRevenueActual();
  const input = buildDcfValuationInputFromOperatingScenarioWithFormalActualAnchors(scenario, target(), [{ inputKey: "opening_revenue", actual }]);
  assert.equal(input.inputs.find((item) => item.key === "opening_revenue")?.value, 100);
  const formalAnchor = input.inputs.find((item) => item.key === "formal_actual_opening_revenue");
  assert.equal(formalAnchor?.value, 95);
  assert.equal(formalAnchor?.epistemicType, "observed_fact");
  assert.equal(formalAnchor?.sourceReferences[0]?.sourceKind, "filing");
  approximately(input.operatingForecasts[0].revenue, 110);
});

test("restated, non-comparable and wrong-period actuals block model anchoring instead of changing assumptions", () => {
  const actual = formalRevenueActual();
  assert.throws(() => buildDcfValuationInputFromOperatingScenarioWithFormalActualAnchors(scenario, target(), [{ inputKey: "opening_revenue", actual: { ...actual, actualStatus: "restated", revisionNumber: 2, supersedesActualId: "actual:2026:revenue:v0", restatementNote: "restated" } }]), /actual_restatement/);
  assert.throws(() => buildDcfValuationInputFromOperatingScenarioWithFormalActualAnchors(scenario, target(), [{ inputKey: "opening_revenue", actual: { ...actual, normalizationStatus: "needs_review", normalizedValue: null, normalizedUnit: null } }]), /actual_not_normalized/);
  assert.throws(() => buildDcfValuationInputFromOperatingScenarioWithFormalActualAnchors(scenario, target(), [{ inputKey: "opening_revenue", actual: { ...actual, fiscalPeriod: "2025FY", fiscalYear: 2025 } }]), /2026FY/);
});

function target() { return { modelVersionId: "dcf:scenario:with-actual", companyId: "company:1", securityCode: "300308.SZ", securityCurrency: "CNY", fxRateToSecurity: null, fxAsOf: null, fxSourceReferences: [], underlyingSharesPerSecurity: 1 }; }

function formalRevenueActual() {
  return normalizeFormalActual({
    actualId: "actual:2026:revenue:v1", securityCode: "300308.SZ", companyId: "company:1", metric: "revenue",
    fiscalYear: 2026, fiscalPeriod: "2026FY", rawValue: 95, rawUnit: "hundred_million_currency", currency: "CNY",
    accountingBasis: "gaap", ownershipBasis: "consolidated", shareBasis: "unspecified", filedAt: "2027-03-01",
    sourceStatement: "2026 annual-report revenue", sourceReferences: [{ sourceKind: "filing", documentId: "filing:2026-annual", url: "https://example.test/2026-annual" }],
    actualStatus: "original", revisionNumber: 1,
  });
}

function approximately(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} to be approximately ${expected}`); }
