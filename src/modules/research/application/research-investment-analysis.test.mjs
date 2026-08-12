import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResearchInvestmentAnalysisPrompt,
  readStoredResearchInvestmentAnalysis,
  researchInvestmentAnalysisTaskName,
  validateResearchInvestmentAnalysisMarkdown,
  validateResearchInvestmentAnalysisTerminalEvidence,
  writeStoredResearchInvestmentAnalysis,
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
    promptVersion: "investment-analysis.taskd.v3",
    preparedAt: "2026-08-11T02:21:37.011Z",
    security: { code: "300476.SZ", name: "胜宏科技", market: "CN", type: "stock", currency: "CNY" },
    marketSnapshot: { asOf: "2026-08-11", source: "xueqiu", latestPrice: 277.839, marketCapYi: 2735.586, peTtm: 58.456, pb: 13.964, psTtm: 13.349473, pcfTtm: 43.456741 },
    businessBoundary: { status: "confirmed", note: null, products: [], customers: [], regions: [] },
    analysisFramework: { primaryFormula: "收入 = 出货量 × ASP", operatingMetrics: ["出货量"], valuationMethods: ["DCF"], stressFactors: ["价格竞争"] },
  });
  assert.match(prompt, /工程实时市场快照只用于报告时点的价格与估值倍数/);
  assert.match(prompt, /## 研究对象/);
  assert.match(prompt, /公司：胜宏科技/);
  assert.match(prompt, /最新价格：277\.84 CNY/);
  assert.match(prompt, /总市值：2735\.59 亿元/);
  assert.match(prompt, /PS（TTM）：13\.35/);
  assert.doesNotMatch(prompt, /本地业务边界状态|状态：confirmed|未提供/);
  assert.match(prompt, /## 分析框架（工程配置，不是公司事实）/);
  assert.doesNotMatch(prompt, /```json|"financials"|工程冻结输入/);
});

class FakeD1 {
  constructor() {
    this.kvCache = new Map();
  }

  prepare(sql) {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    return {
      bind: (...args) => ({
        first: async () => {
          if (normalized.includes("from kv_cache")) {
            const row = this.kvCache.get(`${args[0]}|${args[1]}`) ?? null;
            if (!row) return null;
            if (row.expiresAt != null && row.expiresAt <= args[2]) return null;
            return row;
          }
          throw new Error(`Unexpected D1 statement: ${sql}`);
        },
        run: async () => {
          if (normalized.includes("insert into kv_cache")) {
            this.kvCache.set(`${args[0]}|${args[1]}`, {
              namespace: args[0],
              key: args[1],
              valueJson: args[2],
              expiresAt: args[3],
              updatedAt: args[4],
            });
            return { success: true };
          }
          throw new Error(`Unexpected D1 statement: ${sql}`);
        },
      }),
    };
  }
}

test("investment analysis persists and loads reports from kv_cache without the legacy results table", async () => {
  const db = new FakeD1();
  await writeStoredResearchInvestmentAnalysis(db, "300476.SZ", {
    inputJson: "{\"security\":{\"code\":\"300476.SZ\"}}",
    markdown: "# 1. 第一章\n\n" + "可核验分析内容。".repeat(120),
    citationsJson: "[{\"id\":\"c1\"}]",
    sourcesJson: "[{\"url\":\"https://example.com\"}]",
    terminalEvidenceJson: "{\"schemaVersion\":\"webqa.completion-evidence.v1\",\"outcome\":\"succeeded\"}",
    projectedAt: 1_234_567,
    task: {
      name: "research:investment-analysis:300476.SZ",
      status: "succeeded",
      errorMessage: null,
      createdAt: 1_234_000,
      updatedAt: 1_234_567,
      completedAt: 1_234_567,
    },
  });

  const row = await readStoredResearchInvestmentAnalysis(db, "300476.SZ");
  assert.deepEqual(row, {
    inputJson: "{\"security\":{\"code\":\"300476.SZ\"}}",
    markdown: "# 1. 第一章\n\n" + "可核验分析内容。".repeat(120),
    citationsJson: "[{\"id\":\"c1\"}]",
    sourcesJson: "[{\"url\":\"https://example.com\"}]",
    terminalEvidenceJson: "{\"schemaVersion\":\"webqa.completion-evidence.v1\",\"outcome\":\"succeeded\"}",
    projectedAt: 1_234_567,
    task: {
      name: "research:investment-analysis:300476.SZ",
      status: "succeeded",
      errorMessage: null,
      createdAt: 1_234_000,
      updatedAt: 1_234_567,
      completedAt: 1_234_567,
    },
  });
});

test("investment analysis loads a task-only kv_cache record so refresh state can short-circuit locally", async () => {
  const db = new FakeD1();
  await writeStoredResearchInvestmentAnalysis(db, "603986.SH", {
    inputJson: "{\"security\":{\"code\":\"603986.SH\"}}",
    markdown: null,
    citationsJson: "[]",
    sourcesJson: "[]",
    terminalEvidenceJson: null,
    projectedAt: null,
    task: {
      name: "research:investment-analysis:603986.SH",
      status: "running",
      errorMessage: null,
      createdAt: 2_000_000,
      updatedAt: 2_000_123,
      completedAt: null,
    },
  });

  const row = await readStoredResearchInvestmentAnalysis(db, "603986.SH");
  assert.deepEqual(row, {
    inputJson: "{\"security\":{\"code\":\"603986.SH\"}}",
    markdown: null,
    citationsJson: "[]",
    sourcesJson: "[]",
    terminalEvidenceJson: null,
    projectedAt: null,
    task: {
      name: "research:investment-analysis:603986.SH",
      status: "running",
      errorMessage: null,
      createdAt: 2_000_000,
      updatedAt: 2_000_123,
      completedAt: null,
    },
  });
});
