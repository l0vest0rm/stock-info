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

test("financial prompt makes deterministic risk signals, summaries and data gaps mandatory", () => {
  const prompt = financialAnalysisPrompt({ schemaVersion: "financial-analysis-input.v1", codeVersion: "financial-analysis-code.v7", securityCode: "300308.SZ", asOf: "2026-03-31", entityType: "non_financial", dataQuality: { status: "partial", sourcePolicy: "Eastmoney", statutoryVerification: { status: "partial", verifiedMetrics: [], reason: "missing" }, statements: [], gaps: [] }, periodCoverage: { annual: [], quarterly: [], ttmEndDate: null }, reportedFacts: [], derivedObservations: [], deterministicFlags: [], lineage: { factIds: [], sourceIds: [], inputFingerprint: "test" } });
  assert.match(prompt, /不得使用模型记忆/);
  assert.match(prompt, /财务风险隐患/);
  assert.match(prompt, /不得输出目标价/);
  assert.match(prompt, /不得出现“依据：”/);
  assert.match(prompt, /analysisBrief/);
  assert.match(prompt, /reportedFactTables、observationTables/);
  assert.match(prompt, /不要顺序重抄整张数据表/);
});

test("financial prompt keeps audit evidence out of the model-facing report data, compacts numeric displays and includes summaries", () => {
  const prompt = financialAnalysisPrompt({
    schemaVersion: "financial-analysis-input.v1", codeVersion: "financial-analysis-code.v7", securityCode: "300308.SZ", asOf: "2026-03-31", entityType: "non_financial",
    dataQuality: { status: "partial", sourcePolicy: "Eastmoney", statutoryVerification: { status: "partial", verifiedMetrics: [], reason: "missing" }, statements: [], gaps: [] },
    periodCoverage: { annual: ["FY2024", "FY2025"], quarterly: ["2025Q4", "2026Q1"], ttmEndDate: "2026-03-31" },
    reportedFacts: [
      { metric: "revenue", frequency: "annual", basisId: "CNY:CAS:consolidated:reported", unit: "CNY", points: [
        { period: "FY2024", status: "available", value: 1_000_000_000, formula: "reported", reasonCodes: [], factIds: ["fact:revenue:annual:FY2024"], sources: [{ sourceId: "eastmoney:income:2024", sourceType: "eastmoney" }] },
        { period: "FY2025", status: "available", value: 1_234_567_890.12, formula: "reported", reasonCodes: [], factIds: ["fact:revenue:annual:FY2025"], sources: [{ sourceId: "eastmoney:income:2025", sourceType: "eastmoney" }] },
      ] },
      { metric: "revenue", frequency: "quarterly", basisId: "CNY:CAS:consolidated:reported", unit: "CNY", points: [
        { period: "2025Q4", status: "available", value: 500_000_000, formula: "reported", reasonCodes: [], factIds: ["fact:revenue:q:2025Q4"], sources: [{ sourceId: "eastmoney:income:2025q4", sourceType: "eastmoney" }] },
        { period: "2026Q1", status: "available", value: 700_000_000, formula: "reported", reasonCodes: [], factIds: ["fact:revenue:q:2026Q1"], sources: [{ sourceId: "eastmoney:income:2026q1", sourceType: "eastmoney" }] },
      ] },
    ],
    derivedObservations: [
      { id: "revenue-yoy", kind: "yoy", metric: "revenue", frequency: "annual", period: "FY2025", comparisonPeriod: "FY2024", status: "available", value: 23.4567, unit: "percent", formula: "current / prior - 1", reasonCodes: [], factIds: ["fact:revenue:annual:FY2024", "fact:revenue:annual:FY2025"], sources: [{ sourceId: "eastmoney:income:2025", sourceType: "eastmoney" }] },
      { id: "revenue-qoq", kind: "qoq", metric: "revenue", frequency: "quarterly", period: "2026Q1", comparisonPeriod: "2025Q4", status: "available", value: 40, unit: "percent", formula: "current / prior - 1", reasonCodes: [], factIds: ["fact:revenue:q:2025Q4", "fact:revenue:q:2026Q1"], sources: [{ sourceId: "eastmoney:income:2026q1", sourceType: "eastmoney" }] },
      { id: "revenue-yoy-quarter", kind: "yoy", metric: "revenue", frequency: "quarterly", period: "2026Q1", comparisonPeriod: "2025Q1", status: "available", value: 55.5555, unit: "percent", formula: "current / prior - 1", reasonCodes: [], factIds: ["fact:revenue:q:2025Q1", "fact:revenue:q:2026Q1"], sources: [{ sourceId: "eastmoney:income:2026q1", sourceType: "eastmoney" }] },
      { id: "net-margin", kind: "net_margin", metric: "net_profit", frequency: "quarterly", period: "2026Q1", comparisonPeriod: null, status: "available", value: 34.66515, unit: "percent", formula: "net_profit / revenue", reasonCodes: [], factIds: ["fact:net-profit"], sources: [{ sourceId: "eastmoney:income:2026Q1", sourceType: "eastmoney" }] },
    ],
    deterministicFlags: [], lineage: { factIds: ["fact:revenue:annual:FY2025"], sourceIds: ["eastmoney:income:2025"], inputFingerprint: "test" },
  });
  const input = JSON.parse(prompt.match(/<input_data>\n(.+)\n<\/input_data>/s)?.[1] ?? "");
  assert.deepEqual(input.reportedFactTables.annual, {
    periods: ["FY2024", "FY2025"],
    rows: [{ metric: "revenue", unit: "亿元", values: [10, 12.35] }],
  });
  assert.deepEqual(input.reportedFactTables.quarterly, {
    periods: ["2025Q4", "2026Q1"],
    rows: [{ metric: "revenue", unit: "亿元", values: [5, 7] }],
  });
  assert.ok(input.observationTables.quarterly.rows.some((item) => item.kind === "qoq" && item.metric === "revenue" && item.values.at(-1) === 40));
  assert.ok(input.analysisBrief.metricBriefs.some((item) => item.metric === "revenue" && item.latestQuarter?.qoq === 40 && item.latestQuarter?.yoy === 55.56));
  assert.ok(input.analysisBrief.observationBriefs.some((item) => item.kind === "net_margin" && item.latestQuarter?.value === 34.67));
  assert.deepEqual(input.numericDisplay, { amountUnit: "亿元", shareUnit: "亿股", percentageDecimals: 2 });
  assert.doesNotMatch(JSON.stringify(input), /"status":"available"/);
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
      }] }], trends: [{ id: "revenue-yoy", kind: "yoy", metric: "revenue", frequency: "quarterly", basis,
        period: { kind: "quarter", startDate: "2026-01-01", endDate: "2026-03-31", fiscalYear: 2026, fiscalQuarter: 1 },
        comparisonPeriod: { kind: "quarter", startDate: "2025-01-01", endDate: "2025-03-31", fiscalYear: 2025, fiscalQuarter: 1 },
        status: "available", value: 20, unit: "percent", formula: "current / prior - 1", reasonCodes: [], inputs: [{ factId: "fact:revenue", provenance: { sourceId: "eastmoney:income:2026Q1", sourceType: "eastmoney", locator: "TOTAL_OPERATE_INCOME" } }],
      }], observations: [], gaps: [],
    },
  });
  const point = snapshot.reportedFacts[0].points[0];
  assert.deepEqual(point.sources, [{ sourceId: "eastmoney:income:2026Q1", sourceType: "eastmoney", locator: "TOTAL_OPERATE_INCOME" }]);
  assert.deepEqual(snapshot.lineage.sourceIds, ["eastmoney:income:2026Q1"]);
  assert.ok(snapshot.derivedObservations.some((item) => item.kind === "yoy" && item.metric === "revenue"));
});

test("financial analysis refuses a model run when a primary statement is unavailable", () => {
  assert.throws(() => assertFinancialAnalysisSnapshotCanRun({
    schemaVersion: "financial-analysis-input.v1", codeVersion: "financial-analysis-code.v7", securityCode: "600519.SH", asOf: "unknown", entityType: "unknown",
    dataQuality: { status: "blocked", sourcePolicy: "Eastmoney", statutoryVerification: { status: "partial", verifiedMetrics: [], reason: "missing" }, statements: [{ statementType: "income", rows: 0, sourceHealth: { status: "failed" } }], gaps: [] },
    periodCoverage: { annual: [], quarterly: [], ttmEndDate: null }, reportedFacts: [], derivedObservations: [], deterministicFlags: [], lineage: { factIds: [], sourceIds: [], inputFingerprint: "test" },
  }), /income/);
});
