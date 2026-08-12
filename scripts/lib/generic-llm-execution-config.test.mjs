import assert from "node:assert/strict";
import test from "node:test";
import { loadGenericLlmExecutionConfig, normalizeGenericLlmExecutionConfig, selectGenericLlmExecutionTransport } from "./generic-llm-execution-config.mjs";

function config() {
  return normalizeGenericLlmExecutionConfig({
    version: "test",
    executionTransport: "openai",
    handlerTransports: { generic_raw_model: "openai" },
    taskTypeTransports: { "research_operating_analysis*": "webqa" },
    webqa: { gatewayBaseUrl: "http://127.0.0.1:8766", provider: "chatgpt-web", platform: "stock-info" },
  });
}

test("task-type transport rules take precedence over handler/default transport", () => {
  const value = config();
  assert.equal(selectGenericLlmExecutionTransport(value, { handlerKey: "generic_raw_model", taskType: "research_operating_analysis_low_dependency_stage" }), "webqa");
  assert.equal(selectGenericLlmExecutionTransport(value, { handlerKey: "generic_raw_model", taskType: "generic_raw_model" }), "openai");
  assert.equal(selectGenericLlmExecutionTransport(value, { handlerKey: "other", taskType: "generic_raw_model" }), "openai");
});

test("checked-in runtime config routes operating-analysis tasks to WebQA without changing generic raw defaults", async () => {
  const value = await loadGenericLlmExecutionConfig();
  assert.equal(selectGenericLlmExecutionTransport(value, { handlerKey: "generic_raw_model", taskType: "generic_raw_model", originTaskType: "research_operating_analysis_low_dependency_stage" }), "webqa");
  assert.equal(selectGenericLlmExecutionTransport(value, { handlerKey: "generic_raw_model", taskType: "generic_raw_model" }), "openai");
  assert.equal(value.webqa.newSession, true);
  assert.equal(value.webqa.taskdBaseUrl, "https://task.m2ai.cc");
  assert.equal(value.webqa.taskdNamespace, "stock-info");
  assert.equal(value.webqa.reasoningEffort, null);
});

test("WebQA config preserves omitted reasoning effort instead of injecting high", () => {
  const value = normalizeGenericLlmExecutionConfig({
    version: "test",
    executionTransport: "webqa",
    webqa: { gatewayBaseUrl: "http://127.0.0.1:8766", provider: "chatgpt-web", platform: "stock-info" },
  });
  assert.equal(value.webqa.reasoningEffort, null);
});
