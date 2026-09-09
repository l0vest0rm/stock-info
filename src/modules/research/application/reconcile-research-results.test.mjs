import assert from "node:assert/strict";
import test from "node:test";
import { ResearchTestDatabase } from "../infrastructure/research-test-database.mjs";
import { saveResearchResult, readResearchResult } from "../infrastructure/research-result-repository.ts";
import { reconcileResearchResults } from "./reconcile-research-results.ts";
import { loadResearchInvestmentAnalysis, reconcileResearchInvestmentAnalysis } from "./research-investment-analysis.ts";
import { loadResearchFinancialAnalysis } from "./research-financial-analysis.ts";

const namespaces = ["research_investment_analysis", "research_financial_analysis"];
const code = "300308.SZ";
const taskName = (namespace) => `research:${namespace === namespaces[0] ? "investment" : "financial"}-analysis:${code}`;
const record = (namespace, id = 73) => ({
  pendingInputJson: JSON.stringify({ security: { code } }), pendingSnapshotJson: JSON.stringify({ securityCode: code }),
  inputJson: JSON.stringify({ security: { code } }), snapshotJson: JSON.stringify({ securityCode: code }),
  markdown: null, citationsJson: "[]", sourcesJson: "[]", terminalEvidenceJson: null, projectedAt: null,
  projectionError: null, recovery: { phase: "none", reason: null }, pendingProjection: true,
  task: { taskId: id, name: taskName(namespace), status: "running", errorMessage: null, createdAt: id, updatedAt: id, completedAt: null },
});
const envFor = (DB) => ({ DB, LLM_RUNTIME: "local", TASKD_BASE_URL: "https://taskd.test", STOCK_INFO_TASKD_CALLER_TOKEN: "test-token" });
const completed = (namespace, id = 73) => ({
  task_id: id, namespace: "stock-info", client_task_name: taskName(namespace), task_type: "webqa.chatgpt.v1", input: {},
  status: "succeeded", checkpoint: null, error_message: null, superseded_by_task_id: null, created_at: id, updated_at: id + 1, completed_at: id + 1,
  result: { format: "taskd.webqa.result.v2", content: { format: "web-helper.rich-content.v1", assets: [],
    markdown: Array.from({ length: namespace === namespaces[0] ? 12 : 8 }, (_, i) => `# ${i + 1}. 分析章节\n\n${"可核验的分析内容。".repeat(90)}`).join("\n\n") },
    citations: [], sources: [], raw_snapshot: {}, terminal_evidence: { schemaVersion: "webqa.completion-evidence.v1", outcome: "succeeded" }, execution: {} },
});

test("background projects both research artifacts without page reads; repeated ticks are idempotent", async (t) => {
  const db = new ResearchTestDatabase();
  const requests = [];
  for (const namespace of namespaces) await saveResearchResult(db, namespace, code, record(namespace));
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    requests.push(init.method || "GET");
    const namespace = String(url).includes("investment-analysis") ? namespaces[0] : namespaces[1];
    return Response.json(completed(namespace));
  });
  assert.deepEqual(await reconcileResearchResults(envFor(db)), { inspected: 2, failed: 0 });
  const first = await readResearchResult(db, namespaces[0], code);
  assert.match(JSON.parse(first.valueJson).markdown, /^# 1\./);
  assert.equal(JSON.parse(first.valueJson).retention, "durable");
  assert.deepEqual(await reconcileResearchResults(envFor(db)), { inspected: 0, failed: 0 });
  assert.deepEqual(await readResearchResult(db, namespaces[0], code), first);
  assert.deepEqual(requests, ["GET", "GET"]);
});

test("background rechecks an unprojected failed snapshot and projects a later taskd recovery", async (t) => {
  const db = new ResearchTestDatabase();
  const stale = {
    ...record(namespaces[0]),
    recovery: { phase: "manual_required", reason: "missing provider submission marker" },
    task: { ...record(namespaces[0]).task, status: "failed", errorMessage: "OutcomeUnknown: transport lost", completedAt: 74 },
  };
  await saveResearchResult(db, namespaces[0], code, stale);
  t.mock.method(globalThis, "fetch", async () => Response.json(completed(namespaces[0])));

  assert.deepEqual(await reconcileResearchResults(envFor(db)), { inspected: 1, failed: 0 });
  const actual = JSON.parse((await readResearchResult(db, namespaces[0], code)).valueJson);
  assert.equal(actual.task.status, "succeeded");
  assert.equal(actual.recovery.phase, "none");
  assert.match(actual.markdown, /^# 1\./);
});

test("page reads and production reconciler never call taskd", async (t) => {
  const db = new ResearchTestDatabase();
  for (const namespace of namespaces) await saveResearchResult(db, namespace, code, record(namespace));
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network access"); });
  assert.equal((await loadResearchInvestmentAnalysis(envFor(db), code)).availability, "pending");
  assert.equal((await loadResearchFinancialAnalysis(envFor(db), code)).availability, "pending");
  assert.deepEqual(await reconcileResearchResults({ ...envFor(db), LLM_RUNTIME: "production" }), { inspected: 0, failed: 0 });
});

test("a temporary taskd read failure preserves the recorded task and recovery state", async (t) => {
  const db = new ResearchTestDatabase();
  await saveResearchResult(db, namespaces[0], code, record(namespaces[0]));
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND taskd.test") });
  });

  await assert.rejects(() => reconcileResearchInvestmentAnalysis(envFor(db), code), /taskd request failed/);

  const actual = JSON.parse((await readResearchResult(db, namespaces[0], code)).valueJson);
  assert.equal(actual.task.status, "running");
  assert.deepEqual(actual.recovery, { phase: "none", reason: null });
});

test("a late completed response cannot overwrite a newer submitted run", async (t) => {
  const db = new ResearchTestDatabase();
  const namespace = namespaces[0];
  await saveResearchResult(db, namespace, code, record(namespace));
  t.mock.method(globalThis, "fetch", async () => {
    await saveResearchResult(db, namespace, code, record(namespace, 74));
    return Response.json(completed(namespace));
  });
  await reconcileResearchResults(envFor(db));
  const actual = JSON.parse((await readResearchResult(db, namespace, code)).valueJson);
  assert.equal(actual.task.taskId, 74);
  assert.equal(actual.markdown, null);
});

test("invalid projection preserves an existing report and does not block another artifact", async (t) => {
  const db = new ResearchTestDatabase();
  await saveResearchResult(db, namespaces[0], code, { ...record(namespaces[0]), markdown: "previous accepted report", projectedAt: 12 });
  await saveResearchResult(db, namespaces[1], code, record(namespaces[1]));
  t.mock.method(globalThis, "fetch", async (url) => {
    const namespace = String(url).includes("investment-analysis") ? namespaces[0] : namespaces[1];
    const task = completed(namespace);
    if (namespace === namespaces[0]) task.result.content.markdown = "invalid";
    return Response.json(task);
  });
  assert.deepEqual(await reconcileResearchResults(envFor(db)), { inspected: 2, failed: 1 });
  const failed = JSON.parse((await readResearchResult(db, namespaces[0], code)).valueJson);
  assert.equal(failed.markdown, "previous accepted report");
  assert.equal(failed.recovery.phase, "manual_required");
  assert.ok(JSON.parse((await readResearchResult(db, namespaces[1], code)).valueJson).markdown);
});
