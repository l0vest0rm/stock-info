import assert from "node:assert/strict";
import test from "node:test";
import { createTaskdCallerClient, taskdCallerClient } from "./taskd-client.ts";
import { reconcileTaskdResult } from "./taskd-result-projection.ts";

const task = {
  task_id: 7,
  namespace: "stock-info",
  client_task_name: "investment-analysis:300308.SZ",
  task_type: "webqa.chatgpt.v1",
  input: { prompt: "latest" },
  status: "queued",
  checkpoint: null,
  result: null,
  error_message: null,
  superseded_by_task_id: null,
  created_at: 1,
  updated_at: 1,
  completed_at: null,
};

test("taskd caller submits and manages a task by business name only", async () => {
  const calls = [];
  const client = createTaskdCallerClient({
    baseUrl: "https://task.example.test/",
    namespace: "stock-info",
    token: "token",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(init.method === "DELETE" ? null : JSON.stringify(task), { status: init.method === "DELETE" ? 204 : 200 });
    },
  });

  assert.equal((await client.submit({ name: task.client_task_name, taskType: task.task_type, payload: task.input })).taskId, 7);
  assert.equal((await client.get(task.client_task_name)).name, task.client_task_name);
  assert.equal((await client.cancel(task.client_task_name)).status, "queued");
  assert.equal(await client.delete(task.client_task_name), true);

  assert.deepEqual(JSON.parse(calls[0].init.body), {
    client_task_name: task.client_task_name,
    task_type: task.task_type,
    input: task.input,
  });
  assert.equal(calls[1].url, "https://task.example.test/v1/namespaces/stock-info/tasks/by-name/investment-analysis%3A300308.SZ");
  assert.equal(calls[2].url, "https://task.example.test/v1/namespaces/stock-info/tasks/by-name/investment-analysis%3A300308.SZ/cancel");
});

test("taskd caller accepts taskd's generic caller-token environment name", async () => {
  assert.doesNotThrow(() => taskdCallerClient({
    LLM_RUNTIME: "local",
    TASKD_BASE_URL: "https://task.example.test",
    TASKD_NAMESPACE: "stock-info",
    TASKD_CALLER_TOKEN: "token",
  }));
});

test("taskd caller includes request diagnostics when submit fetch fails", async () => {
  const client = createTaskdCallerClient({
    baseUrl: "https://task.example.test/",
    namespace: "stock-info",
    token: "secret-token-1234",
    tokenSource: "TASKD_CALLER_TOKEN",
    now: () => Date.parse("2026-08-12T01:02:03.000Z"),
    fetchImpl: async () => {
      throw new Error("fetch failed");
    },
  });

  await assert.rejects(
    () => client.submit({
      name: "research:investment-analysis:300308.SZ",
      taskType: "webqa.chatgpt.v1",
      payload: {
        provider: "chatgpt-web",
        platform: "stock-info",
        conversation_id: "stock-info:research:investment-analysis:300308.SZ",
        reasoning_effort: "xhigh",
        timeout_ms: 7_200_000,
        mode: "ask",
      },
      diagnostics: {
        securityCode: "300308.SZ",
        model: "gpt-5.6-luna",
      },
    }),
    /taskd request failed: fetch failed \[method=POST url=https:\/\/task\.example\.test\/v1\/namespaces\/stock-info\/tasks namespace=stock-info tokenSource=TASKD_CALLER_TOKEN token=present\(len=17,last4=1234\) requestedAt=2026-08-12T01:02:03\.000Z errorName=Error errorCode=network_fetch_failed action=submit taskName=research:investment-analysis:300308\.SZ taskType=webqa\.chatgpt\.v1 provider=chatgpt-web platform=stock-info conversationId=stock-info:research:investment-analysis:300308\.SZ reasoningEffort=xhigh timeoutMs=7200000 mode=ask securityCode=300308\.SZ model=gpt-5\.6-luna\]/,
  );
});

test("taskd caller includes response status, reason, code and request time when submit returns an HTTP error", async () => {
  const client = createTaskdCallerClient({
    baseUrl: "https://task.example.test/",
    namespace: "stock-info",
    token: "secret-token-1234",
    now: () => Date.parse("2026-08-12T01:02:03.000Z"),
    fetchImpl: async () => new Response(JSON.stringify({
      code: "unauthorized",
      reason: "caller token rejected",
      message: "caller token rejected",
    }), {
      status: 401,
      statusText: "Unauthorized",
      headers: { "content-type": "application/json" },
    }),
  });

  await assert.rejects(
    () => client.submit({
      name: "company:report-discovery:603986.SH",
      taskType: "webqa.chatgpt.v1",
      payload: {
        provider: "chatgpt-web",
        platform: "stock-info",
        conversation_id: "stock-info:company:report-discovery:603986.SH",
        reasoning_effort: "xhigh",
        timeout_ms: 3_600_000,
        mode: "ask",
      },
    }),
    /taskd returned 401: caller token rejected \[status=401 statusText=Unauthorized requestedAt=2026-08-12T01:02:03\.000Z responseCode=unauthorized responseReason=caller token rejected\]/,
  );
});

test("taskd result projection is retry-safe at the business boundary", async () => {
  const completed = { ...task, status: "succeeded", result: { answer: "final" } };
  let projections = 0;
  const client = { get: async () => completed };
  const first = await reconcileTaskdResult(client, {
    name: task.client_task_name,
    project: async (remote) => { projections += 1; return remote.result.answer; },
  });
  const second = await reconcileTaskdResult(client, {
    name: task.client_task_name,
    project: async (remote) => { projections += 1; return remote.result.answer; },
  });
  assert.equal(first.state, "projected");
  assert.equal(second.state, "projected");
  assert.equal(projections, 2);
});
