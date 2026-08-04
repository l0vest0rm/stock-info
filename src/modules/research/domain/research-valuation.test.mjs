import assert from "node:assert/strict";
import test from "node:test";
import { calculateDcf, calculateDcfSensitivity, calculateReverseDcf, calculateReverseDcfFromSecurity } from "./research-valuation";

const forecasts = [
  { fiscalYear: 2027, revenue: 100, ebitMargin: 0.2, taxRate: 0.25, depreciationAmortization: 4, capitalExpenditure: 6, changeInNetWorkingCapital: 2 },
  { fiscalYear: 2028, revenue: 110, ebitMargin: 0.22, taxRate: 0.25, depreciationAmortization: 4, capitalExpenditure: 7, changeInNetWorkingCapital: 2 },
];
const assumptions = { currency: "USD", wacc: 0.1, terminalGrowth: 0.03, netDebt: 20, dilutedShares: 10 };

test("bridges explicit operating forecasts to EV, equity and per-share value", () => {
  const result = calculateDcf(forecasts, assumptions);
  assert.equal(result.currency, "USD");
  assert.equal(result.forecastYears.length, 2);
  assert(result.enterpriseValue > result.equityValue);
  assert.equal(result.valuePerShare, result.equityValue / 10);
  assert.match(result.formula, /UFCF/);
});

test("refuses non-consecutive forecasts and invalid terminal assumptions", () => {
  assert.throws(() => calculateDcf([{ ...forecasts[0], fiscalYear: 2026 }, { ...forecasts[1], fiscalYear: 2028 }], assumptions), /consecutive/);
  assert.throws(() => calculateDcf(forecasts, { ...assumptions, wacc: 0.03, terminalGrowth: 0.03 }), /greater/);
});

test("reverse valuation does not invent implied revenue without an explicit cash-flow margin", () => {
  const result = calculateReverseDcf({ enterpriseValue: 250, currency: "CNY", wacc: 0.1, terminalGrowth: 0.03 });
  assert.equal(result.impliedTerminalRevenue, null);
  assert(result.impliedTerminalUnleveredFreeCashFlow > 0);
});

test("reverse valuation bridges only explicit price, shares, ADR and FX inputs", () => {
  const result = calculateReverseDcfFromSecurity({
    pricePerSecurity: 12, dilutedUnderlyingShares: 800, underlyingSharesPerSecurity: 8,
    securityCurrency: "USD", valuationCurrency: "HKD", fxRateToValuation: 7.8,
    netDebtAtValuation: 50, wacc: 0.1, terminalGrowth: 0.03,
    terminalFreeCashFlowMargin: 0.1, terminalEbitMargin: 0.2,
  });
  assert.equal(result.marketCapitalizationInSecurityCurrency, 1200);
  assert.equal(result.equityValue, 9360);
  assert.equal(result.enterpriseValue, 9410);
  assert.ok(result.impliedTerminalRevenue !== null);
  assert.ok(result.impliedTerminalEbit !== null);
  assert.throws(() => calculateReverseDcfFromSecurity({
    pricePerSecurity: 12, dilutedUnderlyingShares: 800, underlyingSharesPerSecurity: 8,
    securityCurrency: "USD", valuationCurrency: "HKD", fxRateToValuation: null,
    netDebtAtValuation: 50, wacc: 0.1, terminalGrowth: 0.03,
  }), /explicit positive FX rate/);
});

test("sensitivity preserves the explicit WACC and terminal-growth axes", () => {
  const result = calculateDcfSensitivity(forecasts, assumptions, [0.09, 0.1], [0.02, 0.03]);
  assert.equal(result.length, 2);
  assert.equal(result[0].values.length, 2);
  assert.equal(result[1].values[1].result.currency, "USD");
});
