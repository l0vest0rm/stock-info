#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { fetchLocalRuntime } from "./lib/local-runtime-request.mjs";
import { createLocalJobProvider, loadLocalJobRuntimeConfig, resolveLocalJobApiKey } from "./lib/local-job-provider-registry.mjs";
import { localRuntimeError, localRuntimeLog } from "./lib/local-runtime-log.mjs";

const baseUrl = String(process.env.INFORMATION_PROCESSING_RUNNER_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const apiKey = await resolveLocalJobApiKey();
const runtimeConfig = await loadLocalJobRuntimeConfig();
const handlerConfig = runtimeConfig?.handlers?.informationProcessing;
const pollIntervalMs = positiveInteger(process.env.INFORMATION_PROCESSING_RUNNER_POLL_INTERVAL_MS, handlerConfig?.pollIntervalMs || 2_000);
const concurrency = positiveInteger(process.env.INFORMATION_PROCESSING_RUNNER_CONCURRENCY, handlerConfig?.concurrency || 3);
const runnerInstanceId = `information-processing-runner:${randomUUID()}`;

if (!apiKey) throw new Error("local information processing runner requires OPENAI_API_KEY or ~/.codex/auth.json");

async function request(path, init) {
  const response = await fetchLocalRuntime(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== 200) throw new Error(body?.msg || `information runner endpoint failed: ${response.status}`);
  return body.data;
}
function post(path, body) { return request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback; }

async function runJob(job) {
  if (!job.request) { localRuntimeLog("information-processing", job.status || "missing_request", { task_id: job.taskId || job.jobId, run_id: job.runId, attempt: job.attempt, document_id: job.documentId }); return; }
  const startedAt = Date.now();
  const taskId = job.taskId || job.jobId;
  const heartbeat = setInterval(() => { void post(`/api/knowledge/processing-jobs/${encodeURIComponent(taskId)}/heartbeat`, { runId: job.runId, runnerInstanceId, attempt: job.attempt }).catch(() => {}); }, 10_000);
  localRuntimeLog("information-processing", "started", { task_id: taskId, run_id: job.runId, attempt: job.attempt, document_id: job.documentId });
  try {
    const provider = createLocalJobProvider(apiKey);
    const response = await provider.generate({ model: job.request.model, instructions: job.request.instructions, input: [{ role: "user", content: [{ type: "input_text", text: job.request.input }] }], reasoningEffort: "low", maxOutputTokens: job.request.maxTokens });
    const completed = await post(`/api/knowledge/processing-jobs/${encodeURIComponent(taskId)}/complete`, { request: job.request, text: response.text, raw: response.raw, cached: false, runId: job.runId, runnerInstanceId, attempt: job.attempt });
    localRuntimeLog("information-processing", completed.status || "completed", { task_id: taskId, run_id: job.runId, attempt: job.attempt, document_id: job.documentId, duration_ms: Date.now() - startedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { await post(`/api/knowledge/processing-jobs/${encodeURIComponent(taskId)}/fail`, { request: job.request, error: message, runId: job.runId, runnerInstanceId, attempt: job.attempt }); }
    catch (failure) { localRuntimeError("information-processing", "failure_persist_failed", failure, { task_id: taskId, run_id: job.runId, attempt: job.attempt }); }
    localRuntimeLog("information-processing", "failed", { task_id: taskId, run_id: job.runId, attempt: job.attempt, document_id: job.documentId, duration_ms: Date.now() - startedAt, error: message });
  } finally { clearInterval(heartbeat); }
}

export function startInformationProcessingRunner() {
  let accepting = true; let polling = false; const active = new Set();
  const poll = async () => {
    if (!accepting || polling) return; polling = true;
    try {
      while (accepting && active.size < concurrency) {
        const claimed = await post("/api/knowledge/processing-jobs/claim-next", { runnerInstanceId });
        const job = claimed?.job; if (!job) break;
        let work; work = runJob(job).finally(() => { active.delete(work); void poll(); }); active.add(work);
      }
    } catch (error) { localRuntimeError("information-processing", "claim_failed", error); }
    finally { polling = false; }
  };
  localRuntimeLog("information-processing", "polling_started", { runner_instance_id: runnerInstanceId, concurrency, base_url: baseUrl, poll_interval_ms: pollIntervalMs });
  void poll(); const timer = setInterval(() => void poll(), pollIntervalMs);
  return { async stop({ gracefulTimeoutMs = runtimeConfig?.lease?.gracefulShutdownMs || 30_000 } = {}) { accepting = false; clearInterval(timer); await Promise.race([Promise.allSettled([...active]), new Promise((resolve) => setTimeout(resolve, gracefulTimeoutMs))]); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = startInformationProcessingRunner();
  const stop = () => { void controller.stop().finally(() => process.exit(0)); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
