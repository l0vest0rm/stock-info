import assert from "node:assert/strict";
import test from "node:test";
import { createGenericLlmSchedulerClient, toGenericRawRequest } from "./generic-llm-client.mjs";

test("raw request adapter always uses stream transport and preserves provider options", () => {
  const request = toGenericRawRequest({
    model: "gpt-5.6-luna",
    instructions: "system",
    user: "prompt",
    maxTokens: 123,
    reasoningEffort: "high",
    tools: [{ type: "web_search" }],
    toolChoice: "required",
  });
  assert.equal(request.stream, true);
  assert.equal(request.maxOutputTokens, 123);
  assert.equal(request.reasoningEffort, "high");
  assert.deepEqual(request.input[0].content[0], { type: "input_text", text: "prompt" });
});

test("CLI scheduler client defaults priority to 500 and bridges partial to terminal output", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  let poll = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/llm-tasks") && init.method === "POST") {
      return jsonResponse({ code: 200, data: { task: { taskId: "llm-task:test" } } });
    }
    poll += 1;
    if (poll === 1) {
      return jsonResponse({ code: 200, data: { task: { taskId: "llm-task:test", status: "running", lastRunId: "llm-run:test" }, run: { runId: "llm-run:test" }, artifacts: [{ stepKey: "raw_model", status: "partial", output: { text: "part" } }] } });
    }
    return jsonResponse({ code: 200, data: { task: { taskId: "llm-task:test", status: "completed", lastRunId: "llm-run:test" }, run: { runId: "llm-run:test" }, artifacts: [{ stepKey: "raw_model", status: "partial", output: { text: "part" } }, { stepKey: "raw_model", status: "complete", output: { model: "gpt-5.6-luna", text: "partial result", cached: false, raw: { status: "completed" } } }] } });
  };
  try {
    const client = createGenericLlmSchedulerClient({ baseUrl: "http://local", pollIntervalMs: 1, waitTimeoutMs: 1_000 });
    const result = await client.requestText({ request: toGenericRawRequest({ model: "gpt-5.6-luna", user: "hello" }), targetType: "test" });
    assert.equal(result.text, "partial result");
    const enqueue = calls.find((call) => call.init.method === "POST");
    const body = JSON.parse(enqueue.init.body);
    assert.equal(body.priority, 500);
    assert.equal(body.request.stream, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a disconnected callback does not cancel the durable task waiter", async () => {
  const originalFetch = globalThis.fetch;
  let poll = 0;
  globalThis.fetch = async (_url, init = {}) => {
    if (init.method === "POST") return jsonResponse({ code: 200, data: { task: { taskId: "llm-task:disconnect" } } });
    poll += 1;
    if (poll === 1) return jsonResponse({ code: 200, data: { task: { status: "running" }, artifacts: [{ stepKey: "raw_model", status: "partial", output: { text: "delta" } }] } });
    return jsonResponse({ code: 200, data: { task: { status: "completed" }, artifacts: [{ stepKey: "raw_model", status: "complete", output: { model: "gpt-5.6-luna", text: "delta" } }] } });
  };
  try {
    const client = createGenericLlmSchedulerClient({ baseUrl: "http://local", pollIntervalMs: 1, waitTimeoutMs: 1_000 });
    const result = await client.requestText({ request: toGenericRawRequest({ model: "gpt-5.6-luna", user: "hello" }), onText: () => { throw new Error("SSE disconnected"); } });
    assert.equal(result.text, "delta");
    assert.equal(poll, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(data) {
  return { ok: true, status: 200, async json() { return data; } };
}
