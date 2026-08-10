import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWebQaRequest,
  deriveWebQaSession,
  normalizeWebQaSnapshot,
  runWebQaJob,
  WebQaAdapterError,
} from "./generic-webqa-adapter.mjs";

const answer = (markdown) => ({
  formatVersion: "webqa.answer.v1",
  content: { markdown },
  citations: [{ text: "source", url: "https://example.test/source", title: "Source" }],
  sources: [{ text: "source", url: "https://example.test/source", title: "Source" }],
  rawSnapshot: { provider: "chatgpt-web", complete: true },
});

const config = {
  gatewayBaseUrl: "http://127.0.0.1:8766",
  provider: "chatgpt-web",
  platform: "stock-info-test",
  pollIntervalMs: 0,
  taskTimeoutMs: 50,
  cancelGraceMs: 50,
  heartbeatIntervalMs: 60_000,
  reasoningEffort: "high",
  newSession: true,
  singleTabMode: true,
  attachments: [],
};

function job(progress = null) {
  return {
    taskId: "llm-task:webqa-test",
    runId: "llm-run:webqa-test",
    attempt: 1,
    runnerInstanceId: "runner:webqa-test",
    handlerKey: "generic_raw_model",
    taskType: "research_operating_analysis",
    targetType: "security",
    targetId: "300308.SZ",
    idempotencyKey: "research-operating-analysis:300308.SZ",
    protocolVersion: "llm-task-protocol.v1",
    promptVersion: "investment-analysis.staged.v1",
    progress,
    request: {
      rawModelRequest: {
        provider: "openai",
        model: "gpt-5.6-luna",
        instructions: "只输出结论。",
        input: [{ role: "user", content: [{ type: "input_text", text: "分析这家公司。" }] }],
      },
    },
  };
}

test("WebQA request uses neutral raw input and stable lower-layer identity", () => {
  const first = buildWebQaRequest(job(), config);
  const second = buildWebQaRequest(job(), config);
  assert.deepEqual(first, second);
  assert.equal(first.provider, "chatgpt-web");
  assert.equal(first.platform, "stock-info-test");
  assert.equal(first.new_session, true);
  assert.match(first.input, /任务要求：/);
  assert.doesNotMatch(first.input, /System instructions:/);
  assert.match(first.input, /分析这家公司/);
  assert.equal(first.conversation_id, deriveWebQaSession({
    taskType: "research_operating_analysis",
    targetType: "security",
    targetId: "300308.SZ",
    idempotencyKey: "research-operating-analysis:300308.SZ",
    protocolVersion: "llm-task-protocol.v1",
    promptVersion: "investment-analysis.staged.v1",
  }, config).conversationId);
});

test("WebQA submits once, persists task id, polls terminal state, and writes no partial artifact", async () => {
  const calls = [];
  const snapshots = [
    { task_id: "gateway-task:1", status: "queued", platform: config.platform, conversation_id: "request-session", provider: config.provider, answer: answer("") },
    { task_id: "gateway-task:1", status: "streaming", platform: config.platform, conversation_id: "request-session", provider: config.provider, answer: answer("partial answer") },
    { task_id: "gateway-task:1", status: "completed", platform: config.platform, conversation_id: "request-session", conversation_id_provider: "provider-session", provider: config.provider, provider_url: "https://chatgpt.com/c/provider-session", answer: answer("final answer"), events: [{ status: "completed", at: "2026-08-10T00:00:00Z", message: "done" }] },
  ];
  const gateway = {
    async submit(request) { calls.push({ kind: "submit", request }); return snapshots[0]; },
    async get() { calls.push({ kind: "get" }); return snapshots.shift() || snapshots.at(-1); },
    async cancel() { calls.push({ kind: "cancel" }); throw new Error("cancel should not run"); },
  };
  const persisted = [];
  await runWebQaJob(job(), "runner:webqa-test", {
    config: { ...config, taskTimeoutMs: 1_000 },
    gateway,
    sleep: async () => {},
    runtimePost: async (path, body) => {
      persisted.push({ path, body });
      if (path.endsWith("/heartbeat")) return { active: true };
      return { active: true };
    },
  });
  assert.equal(calls.filter((item) => item.kind === "submit").length, 1);
  assert.ok(calls.filter((item) => item.kind === "get").length >= 2);
  const progress = persisted.filter((item) => item.path.endsWith("/progress"));
  assert.ok(progress.length >= 2);
  assert.equal(progress[0].body.metadata.external.gatewayTaskId, "gateway-task:1");
  assert.equal(progress.at(-1).body.metadata.external.answerLength, "final answer".length);
  assert.equal(persisted.some((item) => item.path.endsWith("/partial")), false);
  const artifact = persisted.find((item) => item.path.endsWith("/artifact"));
  assert.equal(artifact.body.output.text, "final answer");
  assert.deepEqual(artifact.body.output.answer, answer("final answer"));
  assert.equal(Object.hasOwn(artifact.body.output, "answer_text"), false);
  assert.equal(artifact.body.status, "complete");
  assert.equal(persisted.filter((item) => item.path.endsWith("/complete")).length, 1);
});

test("WebQA retries reuse a saved gateway task id and map cancellation to generic failure", async () => {
  const calls = [];
  const gateway = {
    async submit() { throw new Error("submit must not be called for a saved task"); },
    async get(taskId) { calls.push(taskId); return { task_id: taskId, status: "cancelled", provider: config.provider, answer: answer(""), error: "stopped" }; },
    async cancel() { throw new Error("cancel must not be called"); },
  };
  const persisted = [];
  await runWebQaJob(job({ external: { kind: "webqa", taskId: "gateway-task:saved", platform: config.platform, conversationId: "saved-session", provider: config.provider, idempotencyKey: "webqa-saved", mode: "ask", providerUrl: "https://chatgpt.com/c/saved" } }), "runner:webqa-test", {
    config,
    gateway,
    runtimePost: async (path, body) => { persisted.push({ path, body }); return { active: true }; },
    sleep: async () => {},
  });
  assert.deepEqual(calls, ["gateway-task:saved"]);
  const failure = persisted.find((item) => item.path.endsWith("/fail"));
  assert.equal(failure.body.errorCode, "webqa_cancelled");
  assert.equal(persisted.some((item) => item.path.endsWith("/artifact")), false);
});

test("a transient gateway restart retries the saved task instead of failing the app run", async () => {
  let reads = 0;
  const gateway = {
    async submit() { return { task_id: "gateway-task:restart", status: "queued", provider: config.provider, answer: null }; },
    async get() {
      reads += 1;
      if (reads === 1) throw new WebQaAdapterError("webqa_gateway_unavailable", "WebQA gateway request failed: fetch failed");
      return { task_id: "gateway-task:restart", status: "completed", provider: config.provider, answer: answer("recovered final answer") };
    },
    async cancel() { throw new Error("cancel should not run"); },
  };
  const persisted = [];
  await runWebQaJob(job(), "runner:webqa-test", {
    config: { ...config, taskTimeoutMs: 1_000 },
    gateway,
    sleep: async () => {},
    runtimePost: async (path, body) => { persisted.push({ path, body }); return { active: true }; },
  });
  assert.equal(reads, 2);
  assert.equal(persisted.some((item) => item.path.endsWith("/fail")), false);
  assert.equal(persisted.filter((item) => item.path.endsWith("/complete")).length, 1);
});

test("unknown gateway status fails visibly instead of being treated as completion", () => {
  assert.throws(() => normalizeWebQaSnapshot({ task_id: "gateway-task:unknown", status: "mystery" }), /unsupported status/);
});

test("accepted WebQA tasks may omit an answer until the provider completes", () => {
  const snapshot = normalizeWebQaSnapshot({ task_id: "gateway-task:queued", status: "queued", provider: "chatgpt-web", answer: null });
  assert.equal(snapshot.status, "queued");
  assert.equal(snapshot.answer, null);
  assert.throws(
    () => normalizeWebQaSnapshot({ task_id: "gateway-task:completed", status: "completed", provider: "chatgpt-web", answer: null }),
    /completed task lacks structured answer/,
  );
});

test("bounded WebQA timeout requests gateway cancellation and waits for cancelled terminal state", async () => {
  const calls = [];
  let reads = 0;
  let clock = 0;
  const gateway = {
    async submit() { calls.push("submit"); return { task_id: "gateway-task:timeout", status: "queued", provider: config.provider, answer: answer("") }; },
    async get() {
      calls.push("get");
      reads += 1;
      return { task_id: "gateway-task:timeout", status: reads > 1 ? "cancelled" : "queued", provider: config.provider, answer: answer(""), error: reads > 1 ? "stopped" : "" };
    },
    async cancel() { calls.push("cancel"); return { task_id: "gateway-task:timeout", status: "cancelling", cancel_requested: true, provider: config.provider, answer: answer("") }; },
  };
  const persisted = [];
  await runWebQaJob(job(), "runner:webqa-test", {
    config: { ...config, taskTimeoutMs: 10, cancelGraceMs: 100 },
    gateway,
    now: () => { clock += 10; return clock; },
    sleep: async () => {},
    runtimePost: async (path, body) => { persisted.push({ path, body }); return { active: true }; },
  });
  assert.deepEqual(calls, ["submit", "get", "cancel", "get"]);
  assert.equal(persisted.find((item) => item.path.endsWith("/fail")).body.errorCode, "webqa_cancelled");
});
