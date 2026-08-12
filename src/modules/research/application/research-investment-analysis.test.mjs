import assert from "node:assert/strict";
import test from "node:test";

import {
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
