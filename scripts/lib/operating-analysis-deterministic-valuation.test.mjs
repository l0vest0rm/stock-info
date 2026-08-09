import assert from "node:assert/strict";
import test from "node:test";
import { calculateDcfScenario, calculateDeterministicValuation, calculateReverseValuationTarget, calculateSensitivity } from "./operating-analysis-deterministic-valuation.mjs";

const request = { scenario: "base", openingRevenue: 100, openingNetWorkingCapital: 10, amountScale: "million", currency: "CNY", wacc: 0.1, terminalGrowth: 0.03, netDebt: 5, dilutedShares: 20, years: [{ fiscalYear: 2027, revenueGrowth: 0.1, ebitMargin: 0.2, taxRate: 0.25, depreciationAmortizationMargin: 0.03, capitalExpenditureMargin: 0.04, netWorkingCapitalToRevenue: 0.1 }, { fiscalYear: 2028, revenueGrowth: 0.08, ebitMargin: 0.21, taxRate: 0.25, depreciationAmortizationMargin: 0.03, capitalExpenditureMargin: 0.04, netWorkingCapitalToRevenue: 0.1 }] };

test("deterministic DCF records formulas, units, terminal share and EV-to-equity bridge", () => {
  const result = calculateDcfScenario(request);
  assert.equal(result.kind, "dcf");
  assert.equal(result.currency, "CNY");
  assert.equal(result.amountScale, "million");
  assert.equal(result.calculationTrace.formulaVersion, "deterministic-valuation-formula.v1");
  assert.equal(result.equityValue, result.enterpriseValue - result.netDebt);
  assert.equal(result.valuePerShare, Number((result.equityValue / result.dilutedShares).toFixed(8)));
  assert(result.terminalValueShare > 0);
});

test("reverse DCF never invents a missing security bridge", () => {
  assert.throws(() => calculateReverseValuationTarget({ scenario: "base", amountScale: "million", currency: "CNY", wacc: 0.1, terminalGrowth: 0.03 }), /enterpriseValue|net debt/);
  const result = calculateReverseValuationTarget({ scenario: "base", amountScale: "million", currency: "CNY", enterpriseValue: 500, wacc: 0.1, terminalGrowth: 0.03 });
  assert.equal(result.impliedTerminalRevenue, null);
});

test("sensitivity preserves blocked WACC/growth cells and deterministic values", () => {
  const result = calculateSensitivity(request, { scenario: "base", waccValues: [0.02, 0.1], terminalGrowthValues: [0.03] });
  assert.equal(result.values[0].values[0].status, "blocked");
  assert.equal(result.values[0].values[1].status, "complete");
});

test("S10 blocks invalid S9 instead of adding replacement assumptions", () => {
  const result = calculateDeterministicValuation({ scenarioOutput: { status: "blocked", blockedValuationItems: [{ code: "missing" }] } });
  assert.equal(result.status, "blocked");
  assert.equal(result.results.length, 0);
});

test("S10 marks a financial entity not applicable instead of applying an industrial DCF", () => {
  const result = calculateDeterministicValuation({ context: { entityType: "bank" }, scenarioOutput: { status: "complete" } });
  assert.equal(result.status, "not_applicable");
  assert.match(result.blockedValuationItems[0].reason, /金融主体/);
});
