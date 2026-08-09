#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { fetchLocalRuntime } from "./lib/local-runtime-request.mjs";
import { createLocalJobProvider, loadLocalJobRuntimeConfig, resolveLocalJobApiKey } from "./lib/local-job-provider-registry.mjs";
import { localRuntimeError, localRuntimeLog } from "./lib/local-runtime-log.mjs";

const baseUrl = String(process.env.WEB_SEARCH_PACKAGE_RUNNER_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const apiKey = await resolveLocalJobApiKey();
const runtimeConfig = await loadLocalJobRuntimeConfig();
const handlerConfig = runtimeConfig?.handlers?.researchWebSearch;
const pollIntervalMs = positiveInteger(process.env.WEB_SEARCH_PACKAGE_RUNNER_POLL_INTERVAL_MS, handlerConfig?.pollIntervalMs || 2_000);
const concurrency = positiveInteger(process.env.WEB_SEARCH_PACKAGE_RUNNER_CONCURRENCY, handlerConfig?.concurrency || 2);
const runnerInstanceId = `web-search-package-runner:${randomUUID()}`;

if (!apiKey) throw new Error("local Web Search runner requires OPENAI_API_KEY or ~/.codex/auth.json");

async function request(path, init) {
  const response = await fetchLocalRuntime(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== 200) throw new Error(body?.msg || `local runner endpoint failed: ${response.status}`);
  return body.data;
}
function post(path, body) { return request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback; }

async function runJob(job) {
  const startedAt = Date.now();
  const heartbeat = setInterval(() => { void post(`/api/research/web-search-runs/${encodeURIComponent(job.runId)}/heartbeat`, { taskId: job.taskId, runnerInstanceId, attempt: job.attempt }).catch(() => {}); }, 10_000);
  localRuntimeLog("research-web-search", "started", { task_id: job.taskId, run_id: job.runId, attempt: job.attempt, security_code: job.securityCode, package_kind: job.packageKind });
  try {
    const provider = createLocalJobProvider(apiKey);
    const response = await provider.generate({ model: job.model, instructions: job.instructions, input: [{ role: "user", content: [{ type: "input_text", text: job.input }] }], reasoningEffort: job.reasoningEffort, tools: [{ type: "web_search", searchContextSize: "high" }], toolChoice: "required", maxOutputTokens: job.maxOutputTokens, signal: AbortSignal.timeout(job.jobTimeoutMs) });
    await post(`/api/research/web-search-runs/${encodeURIComponent(job.runId)}/complete`, { taskId: job.taskId, model: job.model, text: response.text, webSearch: response.webSearch, runnerInstanceId, attempt: job.attempt });
    localRuntimeLog("research-web-search", "completed", { task_id: job.taskId, run_id: job.runId, attempt: job.attempt, security_code: job.securityCode, package_kind: job.packageKind, duration_ms: Date.now() - startedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { await post(`/api/research/web-search-runs/${encodeURIComponent(job.runId)}/fail`, { taskId: job.taskId, error: message, runnerInstanceId, attempt: job.attempt }); }
    catch (failure) { localRuntimeError("research-web-search", "failure_persist_failed", failure, { task_id: job.taskId, run_id: job.runId, attempt: job.attempt }); }
    localRuntimeLog("research-web-search", "failed", { task_id: job.taskId, run_id: job.runId, attempt: job.attempt, security_code: job.securityCode, package_kind: job.packageKind, duration_ms: Date.now() - startedAt, error: message });
  } finally { clearInterval(heartbeat); }
}

export function startResearchWebSearchPackageRunner() {
  let accepting = true; let polling = false; const active = new Set();
  const poll = async () => {
    if (!accepting || polling) return; polling = true;
    try {
      while (accepting && active.size < concurrency) {
        const claimed = await post("/api/research/web-search-tasks/claim-next", { runnerInstanceId });
        if (!claimed?.request?.securityCode || !claimed?.request?.packageKind) break;
        let work; work = runJob(claimed.request).finally(() => { active.delete(work); void poll(); }); active.add(work);
      }
    } catch (error) { localRuntimeError("research-web-search", "claim_failed", error); }
    finally { polling = false; }
  };
  localRuntimeLog("research-web-search", "polling_started", { runner_instance_id: runnerInstanceId, concurrency, base_url: baseUrl, poll_interval_ms: pollIntervalMs });
  void poll(); const timer = setInterval(() => void poll(), pollIntervalMs);
  return { async stop({ gracefulTimeoutMs = runtimeConfig?.lease?.gracefulShutdownMs || 30_000 } = {}) { accepting = false; clearInterval(timer); await Promise.race([Promise.allSettled([...active]), new Promise((resolve) => setTimeout(resolve, gracefulTimeoutMs))]); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = startResearchWebSearchPackageRunner();
  const stop = () => { void controller.stop().finally(() => process.exit(0)); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
