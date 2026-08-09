import assert from "node:assert/strict";
import test from "node:test";

import { isLocalLlmRuntime, requestLlmText } from "./llm-client.ts";

test("allows LLM calls only for the explicit local Node runtime", () => {
  assert.equal(isLocalLlmRuntime({ LLM_RUNTIME: "local" }), true);
  assert.equal(isLocalLlmRuntime({ LLM_RUNTIME: "production" }), false);
  assert.equal(isLocalLlmRuntime({}), false);
});

test("rejects a production LLM request before accessing the provider or cache", async () => {
  await assert.rejects(
    requestLlmText({ LLM_RUNTIME: "production" }, {
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "must not reach a remote provider" }],
    }),
    /LLM calls are disabled outside local Node development/,
  );
});
