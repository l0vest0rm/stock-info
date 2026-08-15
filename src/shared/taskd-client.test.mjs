import assert from "node:assert/strict";
import test from "node:test";
import { taskdCallerClient } from "./taskd-client.ts";
import { reconcileTaskdResult } from "./taskd-result-projection.ts";
import { extractTaskdWebQaResult } from "./taskd-webqa-result.ts";

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
  const completed = {
    ...task,
    status: "succeeded",
    result: {
      format: "taskd.webqa.result.v2",
      content: { format: "web-helper.rich-content.v1", markdown: "final", assets: [] },
      citations: [],
      sources: [],
      raw_snapshot: {},
      terminal_evidence: {},
      execution: {},
    },
  };
  let projections = 0;
  const client = { get: async () => completed };
  const first = await reconcileTaskdResult(client, {
    name: task.client_task_name,
    project: async (remote) => { projections += 1; return extractTaskdWebQaResult(remote.result).content.markdown; },
  });
  const second = await reconcileTaskdResult(client, {
    name: task.client_task_name,
    project: async (remote) => { projections += 1; return extractTaskdWebQaResult(remote.result).content.markdown; },
  });
  assert.equal(first.state, "projected");
  assert.equal(second.state, "projected");
  assert.equal(projections, 2);
});

test("taskd WebQA result rejects a legacy root-level Markdown payload", () => {
  assert.throws(
    () => extractTaskdWebQaResult({ markdown: "legacy" }),
    /taskd\.webqa\.result\.v2/,
  );
});
