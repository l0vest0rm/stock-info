import assert from "node:assert/strict";
import test from "node:test";
import { ResearchTestDatabase } from "../../research/infrastructure/research-test-database.mjs";
import { readTaskdReportResult, saveTaskdReportResult } from "../../research/infrastructure/research-result-repository.ts";
import {
  loadMacroAnalysis,
  macroAnalysisTaskName,
  reconcileMacroAnalysis,
  syncMacroAnalysis,
  validateMacroAnalysisMarkdown,
  validateMacroAnalysisTerminalEvidence,
} from "./macro-analysis.ts";

const namespace = "macro_analysis";
const key = "GLOBAL";
const input = { schemaVersion: "macro-analysis-input.v1", promptVersion: "macro-analysis.taskd.v1", preparedAt: "2026-09-09T00:00:00.000Z" };
const envFor = (DB) => ({ DB, LLM_RUNTIME: "local", TASKD_BASE_URL: "https://taskd.test", STOCK_INFO_TASKD_CALLER_TOKEN: "test-token" });
const report = [
  ...["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "二十一", "二十二", "二十三", "二十四", "二十五", "二十六", "二十七", "二十八", "二十九", "三十", "三十一"].map((heading) => `# ${heading}、分析章节\n\n${"可核验的宏观投资分析内容。".repeat(24)}`),
  `# 一句话结论\n\n${"中美和全球流动性分析结论。".repeat(20)}`,
].join("\n\n");

function record() {
  return {
    pendingProjection: true, pendingInputJson: JSON.stringify(input), inputJson: JSON.stringify(input), markdown: null,
    citationsJson: "[]", sourcesJson: "[]", terminalEvidenceJson: null, projectedAt: null,
    recovery: { phase: "none", reason: null },
    task: { taskId: 91, name: macroAnalysisTaskName(), status: "running", errorMessage: null, createdAt: 91, updatedAt: 91, completedAt: null },
  };
}

function completedTask() {
  return {
    task_id: 91, namespace: "stock-info", client_task_name: macroAnalysisTaskName(), task_type: "webqa.chatgpt.v1", input: { business_input: input },
    status: "succeeded", checkpoint: null, error_message: null, superseded_by_task_id: null, created_at: 91, updated_at: 92, completed_at: 92,
    result: {
      format: "taskd.webqa.result.v2", content: { format: "web-helper.rich-content.v1", markdown: report, assets: [] }, citations: [], sources: [], raw_snapshot: {},
      terminal_evidence: { schemaVersion: "webqa.completion-evidence.v1", outcome: "succeeded" }, execution: {},
    },
  };
}

test("macro analysis owns one stable latest-only taskd business name", () => {
  assert.equal(macroAnalysisTaskName(), "macro:analysis:global");
});

test("macro analysis accepts only the complete report and a terminal WebQA result", () => {
  assert.doesNotThrow(() => validateMacroAnalysisTerminalEvidence({ schemaVersion: "webqa.completion-evidence.v1", outcome: "succeeded" }));
  assert.throws(() => validateMacroAnalysisTerminalEvidence({ schemaVersion: "webqa.completion-evidence.v1", outcome: "incomplete" }), /lacks terminal WebQA completion evidence/);
  assert.doesNotThrow(() => validateMacroAnalysisMarkdown(report));
  assert.throws(() => validateMacroAnalysisMarkdown("# 一、短报告"), /shorter than 4000 characters/);
});

test("macro analysis accepts a numbered first section nested below a report title", () => {
  assert.doesNotThrow(() => validateMacroAnalysisMarkdown(report.replace("# 一、分析章节", "## 一、分析章节")));
});

test("macro analysis is read-only until explicit synchronization projects the completed taskd result", async (t) => {
  const db = new ResearchTestDatabase();
  await saveTaskdReportResult(db, namespace, key, record());
  t.mock.method(globalThis, "fetch", async () => Response.json(completedTask()));

  const before = await loadMacroAnalysis({ ...envFor(db), LLM_RUNTIME: "production" });
  assert.equal(before.availability, "pending");

  const after = await syncMacroAnalysis(envFor(db));
  const afterStored = JSON.parse((await readTaskdReportResult(db, namespace, key)).valueJson);
  assert.equal(after.availability, "available");
  assert.equal(after.report?.markdown, report);
  const stored = afterStored;
  assert.equal(stored.task.status, "succeeded");
  assert.equal(stored.pendingProjection, false);
  assert.equal(stored.retention, "durable");
});

test("local macro reconciler observes an active taskd run and is idempotent after projection", async (t) => {
  const db = new ResearchTestDatabase();
  await saveTaskdReportResult(db, namespace, key, record());
  const methods = [];
  t.mock.method(globalThis, "fetch", async (_url, init = {}) => {
    methods.push(init.method || "GET");
    return Response.json(completedTask());
  });

  assert.equal(await reconcileMacroAnalysis(envFor(db)), true);
  assert.equal((await loadMacroAnalysis(envFor(db))).availability, "available");
  assert.equal(await reconcileMacroAnalysis(envFor(db)), false);
  assert.deepEqual(methods, ["GET"]);
});

test("production macro reconciler never contacts taskd", async (t) => {
  const db = new ResearchTestDatabase();
  await saveTaskdReportResult(db, namespace, key, record());
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network access"); });
  assert.equal(await reconcileMacroAnalysis({ ...envFor(db), LLM_RUNTIME: "production" }), false);
});

test("a malformed terminal macro report stays terminal and is not retried by the local reconciler", async (t) => {
  const db = new ResearchTestDatabase();
  await saveTaskdReportResult(db, namespace, key, record());
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return Response.json({ ...completedTask(), result: { ...completedTask().result, content: { ...completedTask().result.content, markdown: "# 一、短报告" } } });
  });

  await assert.rejects(() => reconcileMacroAnalysis(envFor(db)), /shorter than 4000 characters/);
  const stored = JSON.parse((await readTaskdReportResult(db, namespace, key)).valueJson);
  assert.equal(stored.task.status, "succeeded");
  assert.equal(stored.pendingProjection, false);
  assert.equal(stored.recovery.phase, "manual_required");
  assert.equal(await reconcileMacroAnalysis(envFor(db)), false);
  assert.equal(requests, 1);
});

test("an interrupted macro task remains terminal rather than appearing pending", async () => {
  const db = new ResearchTestDatabase();
  await saveTaskdReportResult(db, namespace, key, {
    ...record(),
    task: { ...record().task, status: "interrupted", completedAt: 92 },
  });
  const model = await loadMacroAnalysis({ ...envFor(db), LLM_RUNTIME: "production" });
  assert.equal(model.availability, "failed");
  assert.equal(model.resume?.available, false);
});
