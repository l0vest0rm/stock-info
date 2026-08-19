import assert from "node:assert/strict";
import test from "node:test";

import { isLocalLlmRuntime, taskdWebQaInput } from "./llm-client.ts";

test("allows LLM calls only for the explicit local Node runtime", () => {
  assert.equal(isLocalLlmRuntime({ LLM_RUNTIME: "local" }), true);
  assert.equal(isLocalLlmRuntime({ LLM_RUNTIME: "production" }), false);
  assert.equal(isLocalLlmRuntime({}), false);
});

test("renders a taskd payload with the business name but no caller-visible task id", () => {
  const input = taskdWebQaInput({ TASKD_NAMESPACE: "stock-info" }, {
    model: "gpt-5.6-luna",
    messages: [{ role: "system", content: "规则" }, { role: "user", content: "问题" }],
  }, "business:meaningful-name");
  assert.equal(input.conversation_id, "stock-info:business:meaningful-name");
  assert.equal(input.input, "规则\n\n问题");
  assert.equal(Object.hasOwn(input, "task_id"), false);
});
