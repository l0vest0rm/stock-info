import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResearchInvestmentAnalysisPrompt,
  researchInvestmentAnalysisTaskName,
  validateResearchInvestmentAnalysisMarkdown,
  validateResearchInvestmentAnalysisTerminalEvidence,
} from "./research-investment-analysis.ts";

test("investment analysis uses one stable latest-only taskd name per security", () => {
  assert.equal(researchInvestmentAnalysisTaskName("600519.SH"), "research:investment-analysis:600519.SH");
});

test("investment analysis projects only a completed WebQA result", () => {
  assert.doesNotThrow(() => validateResearchInvestmentAnalysisTerminalEvidence({
    terminal_evidence: { schemaVersion: "webqa.completion-evidence.v1", outcome: "succeeded" },
  }));
  assert.throws(
    () => validateResearchInvestmentAnalysisTerminalEvidence({ terminal_evidence: { schemaVersion: "webqa.completion-evidence.v1", outcome: "incomplete" } }),
    /lacks terminal WebQA completion evidence/,
  );
});

test("investment analysis requires the complete twelve-section report contract", () => {
  const report = Array.from({ length: 12 }, (_, index) => `# ${index + 1}. 第 ${index + 1} 章\n\n${"可核验分析内容。".repeat(50)}`).join("\n\n");
  assert.doesNotThrow(() => validateResearchInvestmentAnalysisMarkdown(report));
  assert.throws(() => validateResearchInvestmentAnalysisMarkdown("# 1. 不完整\n\n太短"), /shorter than 800 characters/);
});

test("investment analysis sends a readable research brief instead of a frozen JSON payload", () => {
  const prompt = buildResearchInvestmentAnalysisPrompt({
    schemaVersion: "investment-analysis-input.v2",
    promptVersion: "investment-analysis.taskd.v2",
    preparedAt: "2026-08-11T02:21:37.011Z",
    security: { code: "300476.SZ", name: "胜宏科技", market: "CN", type: "stock", currency: "CNY" },
    marketSnapshot: { asOf: "2026-08-11", source: "xueqiu", latestPrice: 277.83, marketCapYi: 2735.58, peTtm: 58.46, pb: 13.96, psTtm: 13.34, pcfTtm: 43.45 },
    businessBoundary: { status: "confirmed", note: null, products: [], customers: [], regions: [] },
    analysisFramework: { primaryFormula: "收入 = 出货量 × ASP", operatingMetrics: ["出货量"], valuationMethods: ["DCF"], stressFactors: ["价格竞争"] },
  });
  assert.match(prompt, /工程实时市场快照只用于报告时点的价格与估值倍数/);
  assert.match(prompt, /## 研究对象/);
  assert.match(prompt, /公司：胜宏科技/);
  assert.match(prompt, /## 分析框架（工程配置，不是公司事实）/);
  assert.doesNotMatch(prompt, /```json|"financials"|工程冻结输入/);
});
