import assert from "node:assert/strict";
import test from "node:test";
import { assertFinancialAnalysisSnapshotCanRun, buildFinancialAnalysisRiskFlags, buildFinancialAnalysisSnapshot, financialAnalysisPrompt } from "./financial-analysis.ts";

const basis = { id: "CNY:CAS:consolidated:reported", currency: "CNY", accountingStandard: "CAS", scope: "consolidated", revision: "reported" };
function observation({ id, kind, metric, frequency, year, quarter, value, unit = "percent" }) {
  return {
    id, kind, metric, frequency, basis,
    period: { kind: frequency === "annual" ? "annual" : "quarter", startDate: `${year}-01-01`, endDate: `${year}-${quarter === 1 ? "03-31" : "12-31"}`, fiscalYear: year, ...(frequency === "annual" ? {} : { fiscalQuarter: quarter }) },
    status: "available", value, unit, formula: "test", reasonCodes: [], inputs: [],
  };
}

test("financial risk rules trigger only from available deterministic observations", () => {
  const flags = buildFinancialAnalysisRiskFlags([
    observation({ id: "revenue-yoy", kind: "yoy", metric: "revenue", frequency: "quarterly", year: 2026, quarter: 1, value: -12 }),
    observation({ id: "cfo", kind: "cash_conversion", metric: "operating_cash_flow", frequency: "ttm", year: 2026, quarter: 1, value: 72 }),
    observation({ id: "margin-old", kind: "operating_margin", metric: "operating_profit", frequency: "ttm", year: 2025, quarter: 4, value: 21 }),
    observation({ id: "margin-new", kind: "operating_margin", metric: "operating_profit", frequency: "ttm", year: 2026, quarter: 1, value: 16 }),
  ]);
  assert.deepEqual(flags.map((flag) => flag.ruleId), ["cash_conversion_weak", "revenue_yoy_decline", "operating_margin_contraction"]);
  assert.equal(flags.find((flag) => flag.ruleId === "operating_margin_contraction")?.value, -5);
});

test("financial prompt makes deterministic risk signals and data gaps mandatory", () => {
  const prompt = financialAnalysisPrompt({ schemaVersion: "financial-analysis-input.v1", codeVersion: "financial-analysis-code.v4", securityCode: "300308.SZ", asOf: "2026-03-31", entityType: "non_financial", dataQuality: { status: "partial", sourcePolicy: "Eastmoney", statutoryVerification: { status: "partial", verifiedMetrics: [], reason: "missing" }, statements: [], gaps: [] }, periodCoverage: { annual: [], quarterly: [], ttmEndDate: null }, reportedFacts: [], derivedObservations: [], deterministicFlags: [], lineage: { factIds: [], sourceIds: [], inputFingerprint: "test" } });
  assert.match(prompt, /不得使用模型记忆/);
  assert.match(prompt, /财务风险隐患/);
  assert.match(prompt, /不得输出目标价/);
  assert.match(prompt, /不得出现“依据：”/);
  assert.doesNotMatch(prompt, /每项判断均写/);
});

test("financial prompt keeps audit evidence out of the model-facing report data and compacts numeric displays", () => {
  const prompt = financialAnalysisPrompt({
    schemaVersion: "financial-analysis-input.v1", codeVersion: "financial-analysis-code.v4", securityCode: "300308.SZ", asOf: "2026-03-31", entityType: "non_financial",
    dataQuality: { status: "partial", sourcePolicy: "Eastmoney", statutoryVerification: { status: "partial", verifiedMetrics: [], reason: "missing" }, statements: [], gaps: [] },
    periodCoverage: { annual: ["FY2025"], quarterly: ["2026Q1"], ttmEndDate: "2026-03-31" },
    reportedFacts: [{ metric: "revenue", frequency: "annual", basisId: "CNY:CAS:consolidated:reported", unit: "CNY", points: [{ period: "FY2025", status: "available", value: 1_234_567_890.12, formula: "reported", reasonCodes: [], factIds: ["fact:revenue:annual:FY2025"], sources: [{ sourceId: "eastmoney:income:2025", sourceType: "eastmoney" }] }] }],
    derivedObservations: [{ id: "net-margin", kind: "net_margin", metric: "net_profit", frequency: "quarterly", period: "2026Q1", comparisonPeriod: null, status: "available", value: 34.66515, unit: "percent", formula: "net_profit / revenue", reasonCodes: [], factIds: ["fact:net-profit"], sources: [{ sourceId: "eastmoney:income:2026Q1", sourceType: "eastmoney" }] }],
    deterministicFlags: [], lineage: { factIds: ["fact:revenue:annual:FY2025"], sourceIds: ["eastmoney:income:2025"], inputFingerprint: "test" },
  });
  const input = JSON.parse(prompt.match(/<input_data>\n(.+)\n<\/input_data>/s)?.[1] ?? "");
  assert.deepEqual(input.reportedFacts[0].points[0], { period: "FY2025", status: "available", value: 12.35, unit: "亿元" });
  assert.equal(input.reportedFacts[0].unit, "亿元");
  assert.equal(input.derivedObservations[0].value, 34.67);
  assert.equal(input.derivedObservations[0].unit, "percent");
  assert.deepEqual(input.numericDisplay, { amountUnit: "亿元", shareUnit: "亿股", percentageDecimals: 2 });
  assert.doesNotMatch(JSON.stringify(input), /fact:|obs:|sourceId/);
});

test("financial risk rules include cash-flow deterioration and liquidity pressure", () => {
  const flags = buildFinancialAnalysisRiskFlags([
    observation({ id: "cash-old", kind: "cash_conversion", metric: "operating_cash_flow", frequency: "ttm", year: 2025, quarter: 4, value: 110 }),
    observation({ id: "cash-new", kind: "cash_conversion", metric: "operating_cash_flow", frequency: "ttm", year: 2026, quarter: 1, value: 75 }),
    observation({ id: "current", kind: "current_ratio", metric: "current_assets", frequency: "quarterly", year: 2026, quarter: 1, value: 0.8, unit: "times" }),
    observation({ id: "quick", kind: "quick_ratio", metric: "current_assets", frequency: "quarterly", year: 2026, quarter: 1, value: 0.6, unit: "times" }),
  ]);
  assert.deepEqual(flags.map((flag) => flag.ruleId), ["cash_conversion_weak", "current_ratio_low", "cash_conversion_deteriorating", "quick_ratio_low"]);
  assert.equal(flags.find((flag) => flag.ruleId === "cash_conversion_deteriorating")?.value, -35);
});

test("financial analysis snapshot keeps bounded source provenance beside reported facts", () => {
  const snapshot = buildFinancialAnalysisSnapshot({
    securityCode: "300308.SZ", entityType: "non_financial", sourcePolicy: "Eastmoney", availability: "partial",
    statutoryGate: { status: "partial", verifiedMetrics: [], reason: "pending" }, statements: [],
    quality: {
      series: [{ metric: "revenue", frequency: "quarterly", basis, unit: "CNY", points: [{
        period: { kind: "quarter", startDate: "2026-01-01", endDate: "2026-03-31", fiscalYear: 2026, fiscalQuarter: 1 },
        status: "available", value: 100, formula: "reported", reasonCodes: [], inputs: [{ factId: "fact:revenue", provenance: { sourceId: "eastmoney:income:2026Q1", sourceType: "eastmoney", locator: "TOTAL_OPERATE_INCOME" } }],
      }] }], observations: [], gaps: [],
    },
  });
  const point = snapshot.reportedFacts[0].points[0];
  assert.deepEqual(point.sources, [{ sourceId: "eastmoney:income:2026Q1", sourceType: "eastmoney", locator: "TOTAL_OPERATE_INCOME" }]);
  assert.deepEqual(snapshot.lineage.sourceIds, ["eastmoney:income:2026Q1"]);
});

test("financial analysis refuses a model run when a primary statement is unavailable", () => {
  assert.throws(() => assertFinancialAnalysisSnapshotCanRun({
    schemaVersion: "financial-analysis-input.v1", codeVersion: "financial-analysis-code.v4", securityCode: "600519.SH", asOf: "unknown", entityType: "unknown",
    dataQuality: { status: "blocked", sourcePolicy: "Eastmoney", statutoryVerification: { status: "partial", verifiedMetrics: [], reason: "missing" }, statements: [{ statementType: "income", rows: 0, sourceHealth: { status: "failed" } }], gaps: [] },
    periodCoverage: { annual: [], quarterly: [], ttmEndDate: null }, reportedFacts: [], derivedObservations: [], deterministicFlags: [], lineage: { factIds: [], sourceIds: [], inputFingerprint: "test" },
  }), /income/);
});
