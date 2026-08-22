import assert from "node:assert/strict";
import test from "node:test";

import {
  readStoredResearchFinancialAnalysis,
  researchFinancialAnalysisTaskName,
  resumeResearchFinancialAnalysis,
  validateFinancialMarkdown,
  writeStoredResearchFinancialAnalysis,
} from "./research-financial-analysis.ts";

test("financial analysis uses one stable taskd name per security", () => {
  assert.equal(researchFinancialAnalysisTaskName("300308.sz"), "research:financial-analysis:300308.SZ");
});

test("financial-analysis resume observes the recorded task and never submits a second prompt", async () => {
  const db = new FakeD1();
  await writeStoredResearchFinancialAnalysis(db, "300308.SZ", {
    snapshotJson: "{\"securityCode\":\"300308.SZ\"}", markdown: null, citationsJson: "[]", sourcesJson: "[]", terminalEvidenceJson: null, projectedAt: null, projectionError: null,
    task: { taskId: 73, name: "research:financial-analysis:300308.SZ", status: "failed", errorMessage: "transport_lost", createdAt: 100, updatedAt: 200, completedAt: 200 },
  });
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET" });
    return new Response(JSON.stringify({
      task_id: 73, namespace: "stock-info", client_task_name: "research:financial-analysis:300308.SZ", task_type: "webqa.chatgpt.v1", input: {},
      status: "failed", checkpoint: null, result: null, error_message: "transport_lost", superseded_by_task_id: null, created_at: 100, updated_at: 200, completed_at: 200,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await resumeResearchFinancialAnalysis({
      DB: db, LLM_RUNTIME: "local", TASKD_BASE_URL: "https://taskd.test", TASKD_NAMESPACE: "stock-info", STOCK_INFO_TASKD_CALLER_TOKEN: "test-token",
    }, "300308.SZ");
    assert.equal(result.availability, "failed");
    assert.equal(result.task.name, "research:financial-analysis:300308.SZ");
    assert.deepEqual(requests.map(({ method }) => method), ["GET", "GET"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("financial-analysis resume invokes only same-name recovery when the provider turn is checkpointed", async () => {
  const db = new FakeD1();
  await writeStoredResearchFinancialAnalysis(db, "300308.SZ", {
    snapshotJson: "{\"securityCode\":\"300308.SZ\"}", markdown: null, citationsJson: "[]", sourcesJson: "[]", terminalEvidenceJson: null, projectedAt: null, projectionError: null,
    task: { taskId: 73, name: "research:financial-analysis:300308.SZ", status: "failed", errorMessage: "transport_lost", createdAt: 100, updatedAt: 200, completedAt: 200 },
  });
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET" });
    return new Response(JSON.stringify({
      task_id: 73, namespace: "stock-info", client_task_name: "research:financial-analysis:300308.SZ", task_type: "webqa.chatgpt.v1", input: {},
      status: init.method === "POST" ? "queued" : "failed",
      checkpoint: { provider_url: "https://chatgpt.com/c/original", submission: { schema_version: "provider_submission.v1", marker: "twq_73_abc" } },
      result: null, error_message: "transport_lost", superseded_by_task_id: null, created_at: 100, updated_at: 200, completed_at: 200,
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await resumeResearchFinancialAnalysis({
      DB: db, LLM_RUNTIME: "local", TASKD_BASE_URL: "https://taskd.test", TASKD_NAMESPACE: "stock-info", STOCK_INFO_TASKD_CALLER_TOKEN: "test-token",
    }, "300308.SZ");
    assert.deepEqual(requests.map(({ method }) => method), ["GET", "POST", "GET"]);
    assert.match(requests[1].url, /\/by-name\/research%3Afinancial-analysis%3A300308.SZ\/recover$/);
    assert.equal(requests.some(({ url }) => url.endsWith("/tasks")), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("financial analysis requires the complete eight-section report contract", () => {
  const report = Array.from({ length: 8 }, (_, index) => `# ${index + 1}. 第 ${index + 1} 章\n\n${"可核验分析内容。".repeat(80)}`).join("\n\n");
  assert.doesNotThrow(() => validateFinancialMarkdown(report));
  assert.throws(() => validateFinancialMarkdown("# 1. 不完整\n\n太短"), /shorter than 800 characters/);
});

class FakeD1 {
  constructor() { this.kvCache = new Map(); }
  prepare(sql) {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    return { bind: (...args) => ({
      first: async () => {
        if (!normalized.includes("from kv_cache")) throw new Error(`Unexpected D1 statement: ${sql}`);
        const row = this.kvCache.get(`${args[0]}|${args[1]}`) ?? null;
        return !row || (row.expiresAt != null && row.expiresAt <= args[2]) ? null : row;
      },
      run: async () => {
        if (!normalized.includes("insert into kv_cache")) throw new Error(`Unexpected D1 statement: ${sql}`);
        this.kvCache.set(`${args[0]}|${args[1]}`, { namespace: args[0], key: args[1], valueJson: args[2], expiresAt: args[3], updatedAt: args[4] });
        return { success: true };
      },
    }) };
  }
}

test("financial analysis persists frozen input, task state, and result in one kv_cache record", async () => {
  const db = new FakeD1();
  await writeStoredResearchFinancialAnalysis(db, "300308.SZ", {
    snapshotJson: "{\"securityCode\":\"300308.SZ\"}",
    markdown: "# 1. 第一章\n\n" + "可核验分析内容。".repeat(120),
    citationsJson: "[{\"id\":\"c1\"}]",
    sourcesJson: "[{\"url\":\"https://example.com\"}]",
    terminalEvidenceJson: "{\"schemaVersion\":\"webqa.completion-evidence.v1\",\"outcome\":\"succeeded\"}",
    projectedAt: 1_234_567,
    projectionError: null,
    task: { taskId: 73, name: "research:financial-analysis:300308.SZ", status: "succeeded", errorMessage: null, createdAt: 1_234_000, updatedAt: 1_234_567, completedAt: 1_234_567 },
  });
  assert.deepEqual(await readStoredResearchFinancialAnalysis(db, "300308.SZ"), {
    snapshotJson: "{\"securityCode\":\"300308.SZ\"}",
    markdown: "# 1. 第一章\n\n" + "可核验分析内容。".repeat(120),
    citationsJson: "[{\"id\":\"c1\"}]",
    sourcesJson: "[{\"url\":\"https://example.com\"}]",
    terminalEvidenceJson: "{\"schemaVersion\":\"webqa.completion-evidence.v1\",\"outcome\":\"succeeded\"}",
    projectedAt: 1_234_567,
    projectionError: null,
    task: { taskId: 73, name: "research:financial-analysis:300308.SZ", status: "succeeded", errorMessage: null, createdAt: 1_234_000, updatedAt: 1_234_567, completedAt: 1_234_567 },
  });
});
