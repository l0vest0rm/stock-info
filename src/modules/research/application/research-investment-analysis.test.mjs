import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResearchInvestmentAnalysisPrompt,
  loadResearchInvestmentAnalysis,
  readStoredResearchInvestmentAnalysis,
  researchInvestmentAnalysisTaskName,
  resumeResearchInvestmentAnalysis,
  validateResearchInvestmentAnalysisMarkdown,
  validateResearchInvestmentAnalysisTerminalEvidence,
  writeStoredResearchInvestmentAnalysis,
} from "./research-investment-analysis.ts";

test("investment analysis uses one stable latest-only taskd name per security", () => {
  assert.equal(researchInvestmentAnalysisTaskName("600519.SH"), "research:investment-analysis:600519.SH");
});

test("investment analysis projects only a completed WebQA result", () => {
  assert.doesNotThrow(() => validateResearchInvestmentAnalysisTerminalEvidence({ schemaVersion: "webqa.completion-evidence.v1", outcome: "succeeded" }));
  assert.throws(
    () => validateResearchInvestmentAnalysisTerminalEvidence({ schemaVersion: "webqa.completion-evidence.v1", outcome: "incomplete" }),
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
    schemaVersion: "investment-analysis-input.v3",
    promptVersion: "investment-analysis.taskd.v8",
    preparedAt: "2026-08-11T02:21:37.011Z",
    security: { code: "300476.SZ", name: "胜宏科技", market: "CN", type: "stock", currency: "CNY" },
    marketSnapshot: {
      asOf: "2026-08-11", marketDataSource: "xueqiu", valuationSource: "financial-statements", latestPrice: 277.839, marketCapYi: 2735.586,
      peTtm: 58.456, pb: 13.964, psTtm: 13.349473, pcfTtm: 43.456741,
      valuationBasis: {
        income: { source: "financial_report", reportDate: "2026-06-30", noticeDate: "2026-08-10" },
        balance: { source: "financial_report", reportDate: "2026-06-30", noticeDate: "2026-08-10" },
        cashflow: { source: "financial_report", reportDate: "2026-06-30", noticeDate: "2026-08-10" },
      },
    },
    businessBoundary: { status: "confirmed", note: null, products: [], customers: [], regions: [] },
    analysisFramework: { primaryFormula: "收入 = 出货量 × ASP", operatingMetrics: ["出货量"], valuationMethods: ["DCF"], stressFactors: ["价格竞争"] },
  });
  assert.match(prompt, /下方的研究对象和市场快照是已确认信息/);
  assert.match(prompt, /市场快照只用于报告时点的价格与估值倍数/);
  assert.match(prompt, /普通聊天消息中的原始 Markdown 正文/);
  assert.match(prompt, /不得创建或使用 Canvas、可编辑文档/);
  assert.match(prompt, /不得将报告作为下载文件或附件交付/);
  assert.doesNotMatch(prompt, /不得调用任何文档、文件、下载、附件或代码执行工具/);
  assert.match(prompt, /## 研究对象/);
  assert.match(prompt, /公司：胜宏科技/);
  assert.match(prompt, /行情源：xueqiu（仅价格、市值）/);
  assert.match(prompt, /估值源：financial-statements/);
  assert.match(prompt, /最新价格：277\.84 CNY/);
  assert.match(prompt, /总市值：2735\.59 亿元/);
  assert.match(prompt, /PS（TTM）：13\.35/);
  assert.doesNotMatch(prompt, /本地业务边界状态|状态：confirmed|未提供/);
  assert.match(prompt, /## 已确认的市场快照/);
  assert.match(prompt, /## 研究框架（不是公司事实）/);
  assert.doesNotMatch(prompt, /```json|"financials"|工程|程序配置|未配置/);
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
    recovery: { phase: "none", reason: null },
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
    recovery: { phase: "none", reason: null },
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

test("investment analysis keeps a completed v2 report readable and marks its input contract as legacy", async () => {
  const db = new FakeD1();
  const input = {
    schemaVersion: "investment-analysis-input.v2",
    promptVersion: "investment-analysis.taskd.v7",
    security: { code: "601869.SH" },
  };
  const markdown = "# 1. 已完成报告\n\n" + "这是已校验的历史投资研究内容。".repeat(120);
  await writeStoredResearchInvestmentAnalysis(db, "601869.SH", {
    inputJson: JSON.stringify(input),
    markdown,
    citationsJson: "[{\"id\":\"c1\"}]",
    sourcesJson: "[{\"url\":\"https://example.com\"}]",
    terminalEvidenceJson: "{\"schemaVersion\":\"webqa.completion-evidence.v1\",\"outcome\":\"succeeded\"}",
    projectedAt: 1_234_567,
    recovery: { phase: "none", reason: null },
    task: {
      name: "research:investment-analysis:601869.SH",
      status: "succeeded",
      errorMessage: null,
      createdAt: 1_234_000,
      updatedAt: 1_234_567,
      completedAt: 1_234_567,
    },
  });

  const result = await loadResearchInvestmentAnalysis({ DB: db, LLM_RUNTIME: "production" }, "601869.SH");

  assert.equal(result.availability, "available");
  assert.deepEqual(result.input, input);
  assert.equal(result.report?.markdown, markdown);
  assert.deepEqual(result.reportVersion, {
    status: "legacy",
    inputSchemaVersion: "investment-analysis-input.v2",
    currentInputSchemaVersion: "investment-analysis-input.v3",
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
    recovery: { phase: "none", reason: null },
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
    recovery: { phase: "none", reason: null },
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

function taskdTask(status, checkpoint = null) {
  return {
    task_id: 73,
    namespace: "stock-info",
    client_task_name: "research:investment-analysis:300308.SZ",
    task_type: "webqa.chatgpt.v1",
    input: {},
    status,
    checkpoint,
    result: null,
    error_message: status === "failed" ? "OutcomeUnknown: CDP transport is disconnected" : null,
    superseded_by_task_id: null,
    created_at: 100,
    updated_at: 200,
    completed_at: status === "failed" ? 200 : null,
  };
}

async function storeFailedInvestmentTask(db) {
  await writeStoredResearchInvestmentAnalysis(db, "300308.SZ", {
    inputJson: "{\"schemaVersion\":\"investment-analysis-input.v2\",\"security\":{\"code\":\"300308.SZ\"}}",
    markdown: null,
    citationsJson: "[]",
    sourcesJson: "[]",
    terminalEvidenceJson: null,
    projectedAt: null,
    recovery: { phase: "none", reason: null },
    task: {
      name: "research:investment-analysis:300308.SZ",
      status: "failed",
      errorMessage: "OutcomeUnknown: CDP transport is disconnected",
      createdAt: 100,
      updatedAt: 200,
      completedAt: 200,
    },
  });
}

test("investment-analysis resume only sends same-name recover and marks the KV read model recovering", async () => {
  const db = new FakeD1();
  await storeFailedInvestmentTask(db);
  const previousFetch = globalThis.fetch;
  const requests = [];
  let getCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET" });
    const isRecover = init.method === "POST";
    const remote = isRecover
      ? taskdTask("queued", { submission: { schema_version: "provider_submission.v1", state: "click_issued", marker: "twq_73_abc" } })
      : taskdTask(getCount++ === 0 ? "failed" : "queued", { submission: { schema_version: "provider_submission.v1", state: "click_issued", marker: "twq_73_abc" } });
    return new Response(JSON.stringify(remote), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await resumeResearchInvestmentAnalysis({
      DB: db, LLM_RUNTIME: "local", TASKD_BASE_URL: "https://taskd.test", TASKD_NAMESPACE: "stock-info", STOCK_INFO_TASKD_CALLER_TOKEN: "test-token",
    }, "300308.SZ");
    assert.equal(result.availability, "pending");
    assert.deepEqual(result.recovery, { phase: "recovering", reason: "正在只读找回已提交的 ChatGPT 结果；不会重发提示词。" });
    assert.deepEqual(requests.map(({ method }) => method), ["GET", "POST", "GET"]);
    assert.match(requests[1].url, /\/by-name\/research%3Ainvestment-analysis%3A300308.SZ\/recover$/);
    assert.equal(requests.some(({ method, url }) => method === "POST" && /\/tasks$/.test(url)), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("investment-analysis recovery presents a verified legacy result without replaying it", async () => {
  const db = new FakeD1();
  await storeFailedInvestmentTask(db);
  const previousFetch = globalThis.fetch;
  let getCount = 0;
  globalThis.fetch = async (_url, init = {}) => {
    const isRecover = init.method === "POST";
    const remote = isRecover
      ? taskdTask("queued", { submission: { schema_version: "provider_submission.v1", state: "click_issued", marker: "twq_73_abc" } })
      : getCount++ === 0
        ? taskdTask("failed", { submission: { schema_version: "provider_submission.v1", state: "click_issued", marker: "twq_73_abc" } })
        : completedTask();
    return new Response(JSON.stringify(remote), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await resumeResearchInvestmentAnalysis({
      DB: db, LLM_RUNTIME: "local", TASKD_BASE_URL: "https://taskd.test", TASKD_NAMESPACE: "stock-info", STOCK_INFO_TASKD_CALLER_TOKEN: "test-token",
    }, "300308.SZ");
    assert.equal(result.availability, "available");
    assert.equal(result.recovery.phase, "none");
    assert.match(result.report?.markdown, /^# 1\. /);
    assert.deepEqual(result.reportVersion, {
      status: "legacy",
      inputSchemaVersion: "investment-analysis-input.v2",
      currentInputSchemaVersion: "investment-analysis-input.v3",
    });
    assert.match((await readStoredResearchInvestmentAnalysis(db, "300308.SZ")).markdown, /^# 1\. /);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("investment-analysis resume refuses a missing marker without submitting or recovering", async () => {
  const db = new FakeD1();
  await storeFailedInvestmentTask(db);
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET" });
    return new Response(JSON.stringify(taskdTask("failed")), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await resumeResearchInvestmentAnalysis({
      DB: db, LLM_RUNTIME: "local", TASKD_BASE_URL: "https://taskd.test", TASKD_NAMESPACE: "stock-info", STOCK_INFO_TASKD_CALLER_TOKEN: "test-token",
    }, "300308.SZ");
    assert.equal(result.recovery.phase, "manual_required");
    assert.match(result.recovery.reason, /marker/);
    assert.deepEqual(requests.map(({ method }) => method), ["GET", "GET"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

function completedTask() {
  const markdown = Array.from({ length: 12 }, (_, index) => `# ${index + 1}. 第 ${index + 1} 章\n\n${"可核验分析内容。".repeat(50)}`).join("\n\n");
  return {
    ...taskdTask("succeeded", { submission: { schema_version: "provider_submission.v1", state: "click_issued", marker: "twq_73_abc" } }),
    completed_at: 300,
    error_message: null,
    result: {
      format: "taskd.webqa.result.v2",
      content: { format: "web-helper.rich-content.v1", markdown, assets: [] },
      citations: [],
      sources: [],
      raw_snapshot: {},
      terminal_evidence: { schemaVersion: "webqa.completion-evidence.v1", outcome: "succeeded" },
      execution: {},
    },
  };
}
