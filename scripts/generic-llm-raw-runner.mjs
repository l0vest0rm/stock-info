#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { fetchLocalRuntime } from "./lib/local-runtime-request.mjs";
import { createLocalJobProvider, resolveLocalJobApiKey } from "./lib/local-job-provider-registry.mjs";
import { localRuntimeError, localRuntimeLog } from "./lib/local-runtime-log.mjs";

const baseUrl = String(process.env.GENERIC_LLM_RAW_RUNNER_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const apiKey = await resolveLocalJobApiKey();
const runnerInstanceId = `generic-llm-raw-runner:${randomUUID()}`;

async function request(path, init) {
  const response = await fetchLocalRuntime(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== 200) throw new Error(body?.msg || `generic raw LLM endpoint failed: ${response.status}`);
  return body.data;
}

function post(path, body) {
  return request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** Execute one claimed raw/model task.  The provider stream is independent of
 * any request waiter; only the durable lease/heartbeat can fence it. */
export async function runJob(job, owner = runnerInstanceId) {
  const requestInput = job?.request?.rawModelRequest || job?.rawModelRequest || job?.request;
  if (!requestInput || typeof requestInput !== "object") throw new Error("generic raw model request is missing");
  if (!apiKey) throw new Error("generic raw model runner requires OPENAI_API_KEY or ~/.codex/auth.json");
  const startedAt = Date.now();
  let text = "";
  let sequence = 0;
  const heartbeat = setInterval(() => {
    void post(`/api/llm-tasks/${encodeURIComponent(job.runId)}/heartbeat`, {
      taskId: job.taskId,
      runnerInstanceId: owner,
      attempt: job.attempt,
    }).catch(() => {});
  }, 10_000);
  const persistPartial = async (delta) => {
    if (!delta) return;
    text += delta;
    sequence += 1;
    await post(`/api/llm-tasks/${encodeURIComponent(job.runId)}/partial`, {
      taskId: job.taskId,
      runnerInstanceId: owner,
      attempt: job.attempt,
      stepKey: "raw_model",
      sequence,
      delta,
      text,
    });
  };
  localRuntimeLog("generic-llm-raw", "started", { task_id: job.taskId, run_id: job.runId, attempt: job.attempt });
  try {
    const provider = createLocalJobProvider(apiKey);
    const response = await provider.stream({
      ...requestInput,
      // A request disconnect never reaches this runner's signal. The durable
      // task continues until the provider or lease timeout settles it.
      signal: undefined,
      onText: persistPartial,
    });
    const terminalText = response.text || text;
    await post(`/api/llm-tasks/${encodeURIComponent(job.runId)}/artifact`, {
      taskId: job.taskId,
      runnerInstanceId: owner,
      attempt: job.attempt,
      stepKey: "raw_model",
      outputType: "json",
      status: "complete",
      output: {
        provider: requestInput.provider,
        model: response.model || requestInput.model,
        text: terminalText,
        reasoningText: response.reasoningText || "",
        webSearch: response.webSearch || null,
        raw: response.raw || null,
        cached: false,
      },
      terminalMetadata: { sequence, streamed: true },
    });
    await post(`/api/llm-tasks/${encodeURIComponent(job.runId)}/complete`, {
      taskId: job.taskId,
      runnerInstanceId: owner,
      attempt: job.attempt,
      status: "completed",
      metadata: { sequence, streamed: true },
    });
    localRuntimeLog("generic-llm-raw", "completed", { task_id: job.taskId, run_id: job.runId, attempt: job.attempt, duration_ms: Date.now() - startedAt, text_length: terminalText.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await post(`/api/llm-tasks/${encodeURIComponent(job.runId)}/fail`, {
      taskId: job.taskId,
      runnerInstanceId: owner,
      attempt: job.attempt,
      errorCode: "provider_failed",
      error: message,
    }).catch((failure) => localRuntimeError("generic-llm-raw", "failure_persist_failed", failure, { task_id: job.taskId, run_id: job.runId }));
    localRuntimeLog("generic-llm-raw", "failed", { task_id: job.taskId, run_id: job.runId, attempt: job.attempt, duration_ms: Date.now() - startedAt, error: message });
  } finally {
    clearInterval(heartbeat);
  }
}

// The universal dispatcher imports runJob directly. A standalone invocation
// is intentionally not a second poller; it only provides an explicit smoke
// hook for local diagnostics.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  localRuntimeLog("generic-llm-raw", "ready", { runner_instance_id: runnerInstanceId, base_url: baseUrl });
}
