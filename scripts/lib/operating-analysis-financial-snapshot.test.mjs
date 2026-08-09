import assert from "node:assert/strict";
import test from "node:test";
import { buildOperatingAnalysisFinancialContext, financialSnapshotForStage } from "./operating-analysis-financial-snapshot.mjs";

const statement = (rows, source = "eastmoney") => ({ dataAsOf: "2026-08-09T00:00:00.000Z", reportingCurrencies: ["CNY"], rows: rows.map(([reportDate, fiscalPeriod, payload]) => ({ reportDate, fiscalPeriod, source, payload })) });
const context = buildOperatingAnalysisFinancialContext({
  income: statement([["2026-03-31", "一季度", { CURRENCY: "CNY", TOTAL_OPERATE_INCOME: 100, OPERATE_COST: 60, OPERATE_PROFIT: 25, PARENT_NETPROFIT: 20, UNUSED_PROVIDER_FIELD: 999 }]]),
  balance: statement([["2026-03-31", "一季度", { CURRENCY: "CNY", MONETARYFUNDS: 50, ACCOUNTS_RECE: 15, INVENTORY: 20, TOTAL_ASSETS: 200, TOTAL_LIABILITIES: 70, TOTAL_PARENT_EQUITY: 120, SHORT_LOAN: 10, LONG_LOAN: 15, GOODWILL: 4, UNUSED_PROVIDER_FIELD: 999 }]]),
  cashflow: statement([["2026-03-31", "一季度", { CURRENCY: "CNY", NETCASH_OPERATE: 30, CONSTRUCT_LONG_ASSET: 8, UNUSED_PROVIDER_FIELD: 999 }]]),
});

test("financial context projects only the selected statement fields and deterministic metrics", () => {
  const analysis = financialSnapshotForStage(context.descriptor, context, "financial_analysis");
  assert.equal(analysis.incomeStatement[0].values.TOTAL_OPERATE_INCOME, 100);
  assert.equal("UNUSED_PROVIDER_FIELD" in analysis.incomeStatement[0].values, false);
  assert.equal(analysis.deterministicMetrics[0].grossMargin, 0.4);
  assert.equal(analysis.deterministicMetrics[0].freeCashFlow, 22);
  assert.equal("rows" in analysis, false);
  assert.equal("payload" in JSON.parse(JSON.stringify(analysis)), false);
});

test("each model stage receives only its financial minimum", () => {
  const baseline = financialSnapshotForStage(context.descriptor, context, "company_baseline");
  const operating = financialSnapshotForStage(context.descriptor, context, "operating_analysis");
  const valuation = financialSnapshotForStage(context.descriptor, context, "valuation_inputs");
  const conclusion = financialSnapshotForStage(context.descriptor, context, "valuation_conclusion");
  assert.equal("incomeStatement" in baseline, false);
  assert.equal("incomeStatement" in operating, false);
  assert.equal(operating.operatingTrend.length, 1);
  assert.equal("incomeStatement" in valuation, false);
  assert.equal("operatingTrend" in valuation, true);
  assert.equal("operatingTrend" in conclusion, false);
});
