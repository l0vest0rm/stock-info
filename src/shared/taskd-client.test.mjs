import assert from "node:assert/strict";
import test from "node:test";
import { taskdCallerClient } from "./taskd-client.ts";
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

test("taskd caller accepts taskd's generic caller-token environment name", async () => {
  assert.doesNotThrow(() => taskdCallerClient({
    LLM_RUNTIME: "local",
    TASKD_BASE_URL: "https://task.example.test",
    TASKD_NAMESPACE: "stock-info",
    TASKD_CALLER_TOKEN: "token",
  }));
});

test("taskd caller remains unavailable outside the local LLM runtime", () => {
  assert.throws(
    () => taskdCallerClient({
      LLM_RUNTIME: "production",
      TASKD_BASE_URL: "https://task.example.test",
      TASKD_NAMESPACE: "stock-info",
      TASKD_CALLER_TOKEN: "token",
    }),
    /taskd caller is only available in local LLM runtime/,
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
