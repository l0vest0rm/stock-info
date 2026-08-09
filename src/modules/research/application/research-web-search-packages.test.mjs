import assert from "node:assert/strict";
import test from "node:test";
import { completeResearchWebSearchPackageRun, failResearchWebSearchPackageRun, parseResearchWebSearchPackage } from "./research-web-search-packages.ts";

function staleAttemptDb() {
  return {
    prepare(sql) {
      return {
        bind() {
          if (/from llm_tasks/.test(sql)) return { first: async () => ({
            taskId: "task-a", taskType: "research_web_search", targetType: "security", targetId: "300308.SZ",
            idempotencyKey: "web-search-package:industry_market", protocolVersion: "llm-task-protocol.v1", promptVersion: "research-web-search.industry-market.v3", status: "running",
            requestedModel: "gpt-5.6-luna", requestedReasoningEffort: "high", lastRunId: "run-b", metadataJson: JSON.stringify({ packageKind: "industry_market" }),
            lastErrorCode: null, lastErrorMessage: null, createdAt: Date.now() - 1000, startedAt: Date.now() - 500, completedAt: null, updatedAt: Date.now(),
          }) };
          if (/from llm_runs/.test(sql)) return { first: async () => ({
            runId: "run-b", taskId: "task-a", attempt: 2, provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "high", promptVersion: "research-web-search.industry-market.v3",
            inputFingerprint: null, inputAsOf: null, inputJson: null, promptJson: null, status: "running", leaseOwner: "runner-b", leaseUntil: Date.now() + 60_000,
            heartbeatAt: Date.now(), terminalMetadataJson: null, errorCode: null, errorMessage: null, startedAt: Date.now() - 500, completedAt: null, updatedAt: Date.now(),
          }) };
          return { run: async () => ({ meta: { changes: 0 } }) };
        },
      };
    },
  };
}

test("runner A late terminal writes cannot replace runner B's web-search attempt", async () => {
  const db = staleAttemptDb();
  await assert.rejects(
    () => completeResearchWebSearchPackageRun(db, { taskId: "task-a", runId: "run-b", attempt: 1, runnerInstanceId: "runner-a", response: { model: "gpt-5.6-luna", text: "late", webSearch: { searched: true, citations: [{ title: "source", url: "https://example.test" }] } } }),
    /lease is no longer owned/,
  );
  await assert.rejects(() => failResearchWebSearchPackageRun(db, { taskId: "task-a", runId: "run-b", error: "late failure", runnerInstanceId: "runner-a", attempt: 1 }), /lease is no longer owned/);
});

test("source-package parsing keeps only cited URLs as verified evidence", () => {
  const parsed = parseResearchWebSearchPackage(JSON.stringify({
    summary: "公司所在市场需求保持增长。",
    evidence_records: [
      { tab_id: "market", field_key: "market_size", subject: "市场规模", statement: "公开资料披露市场规模为 100 亿元。", numeric_value: 100, unit: "亿元", source_url: "https://example.test/report" },
      { tab_id: "market", field_key: "uncited", subject: "未回链", statement: "该条没有可核验来源。" },
    ],
    missing_fields: [], conflicts: [], refresh_triggers: [],
  }), ["market"], [{ title: "报告", url: "https://example.test/report" }]);
  assert.equal(parsed.items[0].status, "verified");
  assert.equal(parsed.items[1].status, "uncited");
});
