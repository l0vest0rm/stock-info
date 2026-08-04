import assert from "node:assert/strict";
import test from "node:test";
import { buildDcfValuationModelVersion } from "./valuation-model-version";

const base = {
  modelVersionId: "dcf:test", companyId: "company:test", securityCode: "BABA.US", asOf: 100, createdAt: 100, status: "draft",
  valuationCurrency: "HKD", amountScale: "million HKD", securityCurrency: "USD", fxRateToSecurity: 0.128, fxAsOf: 100,
  fxSourceReferences: [{ sourceKind: "external_url", url: "https://example.test/fx" }], underlyingSharesPerSecurity: 8,
  inputs: [
    { key: "wacc", label: "WACC", value: 0.1, unit: "ratio", epistemicType: "analysis_assumption", sourceReferences: [] },
    { key: "terminal_growth", label: "g", value: 0.03, unit: "ratio", epistemicType: "analysis_assumption", sourceReferences: [] },
    { key: "net_debt", label: "net debt", value: 10, unit: "million HKD", epistemicType: "observed_fact", sourceReferences: [{ sourceKind: "external_url", url: "https://example.test/debt" }] },
    { key: "diluted_shares", label: "shares", value: 100, unit: "million shares", epistemicType: "observed_fact", sourceReferences: [{ sourceKind: "external_url", url: "https://example.test/shares" }] },
  ],
  operatingForecasts: [
    { fiscalYear: 2026, revenue: 100, ebitMargin: 0.3, taxRate: 0.2, depreciationAmortization: 4, capitalExpenditure: 6, changeInNetWorkingCapital: 2 },
    { fiscalYear: 2027, revenue: 110, ebitMargin: 0.3, taxRate: 0.2, depreciationAmortization: 4, capitalExpenditure: 6, changeInNetWorkingCapital: 2 },
  ],
  sourceReferences: [],
};

test("DCF model versions retain explicit currency and ADR bridge", () => {
  const model = buildDcfValuationModelVersion(base);
  assert.equal(model.result.currency, "HKD");
  assert.equal(model.perSecurityValue, model.result.valuePerShare * 8 * 0.128);
  assert.equal(model.sensitivity.length, 3);
});

test("cross-currency valuation refuses an unproven FX bridge", () => {
  assert.throws(() => buildDcfValuationModelVersion({ ...base, fxSourceReferences: [] }), /requires FX source references/);
  assert.throws(() => buildDcfValuationModelVersion({ ...base, fxRateToSecurity: null }), /requires an explicit positive FX rate/);
});

test("DCF refuses to turn net debt or share count into unsupported assumptions", () => {
  assert.throws(() => buildDcfValuationModelVersion({ ...base, inputs: base.inputs.map((item) => item.key === "net_debt" ? { ...item, epistemicType: "analysis_assumption", sourceReferences: [] } : item) }), /net_debt must be an observed fact/);
});
