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
