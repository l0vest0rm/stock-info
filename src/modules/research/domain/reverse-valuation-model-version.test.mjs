import assert from "node:assert/strict";
import test from "node:test";
import { buildReverseDcfValuationModelVersion } from "./reverse-valuation-model-version";

const source = [{ sourceKind: "external_url", url: "https://example.test/evidence" }];
const base = {
  modelVersionId: "reverse:test", companyId: "company:test", securityCode: "BABA.US", asOf: 100, createdAt: 100, status: "draft",
  valuationCurrency: "HKD", amountScale: "million HKD", securityCurrency: "USD",
  pricePerSecurity: 80, priceAsOf: 100, priceSourceReferences: source,
  dilutedUnderlyingShares: 21000, dilutedSharesScale: "million shares", dilutedSharesSourceReferences: source, underlyingSharesPerSecurity: 8,
  netDebtAtValuation: -100000, netDebtSourceReferences: source,
  fxRateToValuation: 7.8, fxAsOf: 100, fxSourceReferences: source,
  wacc: 0.1, terminalGrowth: 0.03, terminalFreeCashFlowMargin: 0.1, terminalEbitMargin: 0.2,
  assumptionSourceReferences: [],
};

test("reverse DCF version freezes dated market facts, ADR ratio, FX and implied output", () => {
  const model = buildReverseDcfValuationModelVersion(base);
  assert.equal(model.result.marketCapitalizationInSecurityCurrency, 210000);
  assert.equal(model.result.equityValue, 1638000);
  assert.ok(model.result.impliedTerminalRevenue !== null);
  assert.equal(model.sourceReferences.length, 1);
});

test("reverse DCF refuses missing price, share, net-debt or FX evidence", () => {
  assert.throws(() => buildReverseDcfValuationModelVersion({ ...base, priceSourceReferences: [] }), /stated security price requires/);
  assert.throws(() => buildReverseDcfValuationModelVersion({ ...base, dilutedSharesSourceReferences: [] }), /diluted underlying shares requires/);
  assert.throws(() => buildReverseDcfValuationModelVersion({ ...base, netDebtSourceReferences: [] }), /net debt at valuation requires/);
  assert.throws(() => buildReverseDcfValuationModelVersion({ ...base, fxSourceReferences: [] }), /FX bridge requires/);
});
