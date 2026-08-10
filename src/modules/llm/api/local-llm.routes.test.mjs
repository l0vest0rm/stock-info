import assert from "node:assert/strict";
import test from "node:test";
import { localLlmRoutes } from "./local-llm.routes.ts";

test("raw task enqueue rejects an invalid priority before touching the database", async () => {
  const response = await localLlmRoutes.request("http://example.test/llm-tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request: { model: "gpt-5.6-luna", input: [] }, priority: 1001 }),
  }, { LLM_RUNTIME: "local", DB: {} });
  assert.equal(response.status, 400);
  assert.match(String((await response.json()).msg), /0 to 1000/);
});

test("raw task status endpoint exposes the latest run and persisted partial artifact for reconnect", async () => {
  const taskId = "llm-task:reconnect";
  const runId = "llm-run:reconnect";
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            first: async () => /from llm_tasks/.test(sql) ? {
              taskId, taskType: "generic_raw_model", targetType: "llm_request", targetId: "request:1",
              idempotencyKey: "request:1", protocolVersion: "llm-task-protocol.v1", promptVersion: "generic-raw-model.v1",
              status: "running", requestedModel: "gpt-5.6-luna", requestedReasoningEffort: null, lastRunId: runId,
              metadataJson: JSON.stringify({}), lastErrorCode: null, lastErrorMessage: null, priority: 500, queueSequence: 1,
              handlerKey: "generic_raw_model", executionMode: "model", parentTaskId: null, stageKey: null, readyAt: 1,
              createdAt: 1, startedAt: 2, completedAt: null, updatedAt: 2,
            } : /from llm_runs/.test(sql) ? {
              runId, taskId, attempt: 1, provider: "openai", model: "gpt-5.6-luna", reasoningEffort: null,
              promptVersion: "generic-raw-model.v1", inputFingerprint: null, inputAsOf: null, inputJson: null, promptJson: null,
              lineageRunId: null, status: "running", leaseOwner: "dispatcher", leaseUntil: Date.now() + 1000,
              heartbeatAt: Date.now(), currentStepKey: "raw_model", progressJson: JSON.stringify({ sequence: 2 }),
              progressUpdatedAt: Date.now(), terminalMetadataJson: null, errorCode: null, errorMessage: null,
              startedAt: 2, completedAt: null, updatedAt: 2,
            } : null,
            all: async () => ({ results: [{ artifactId: "llm-artifact:1", runId, stepKey: "raw_model", stageVersion: null, inputFingerprint: null, upstreamArtifactIdsJson: "[]", sourceIdsJson: "[]", claimIdsJson: "[]", evidenceIdsJson: "[]", unknownIdsJson: "[]", outputType: "json", status: "partial", outputJson: JSON.stringify({ text: "partial" }), outputMarkdown: null, structureValid: null, blockedJson: null, errorCode: null, errorMessage: null, terminalMetadataJson: JSON.stringify({ sequence: 2 }), projectionVersion: null, completedAt: 3 }] }),
          };
        },
      };
    },
  };
  const response = await localLlmRoutes.request(`http://example.test/llm-tasks/${encodeURIComponent(taskId)}`, {}, { LLM_RUNTIME: "local", DB: db });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.data.task.taskId, taskId);
  assert.equal(payload.data.run.runId, runId);
  assert.equal(payload.data.artifacts[0].output.text, "partial");
});
