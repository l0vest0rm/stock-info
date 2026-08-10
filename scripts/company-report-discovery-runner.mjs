#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { fetchLocalRuntime } from "./lib/local-runtime-request.mjs";
import { createLocalJobProvider, loadLocalJobRuntimeConfig, resolveLocalJobApiKey } from "./lib/local-job-provider-registry.mjs";
import { localRuntimeError, localRuntimeLog } from "./lib/local-runtime-log.mjs";
import { loadGenericLlmExecutionConfig, selectGenericLlmExecutionTransport } from "./lib/generic-llm-execution-config.mjs";
import { runWebQaJob } from "./lib/generic-webqa-adapter.mjs";

const baseUrl = String(process.env.COMPANY_REPORT_DISCOVERY_RUNNER_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const apiKey = await resolveLocalJobApiKey();
const runtimeConfig = await loadLocalJobRuntimeConfig();
const executionConfig = await loadGenericLlmExecutionConfig();
const handlerConfig = runtimeConfig?.handlers?.researchWebSearch;
const pollIntervalMs = positiveInteger(process.env.COMPANY_REPORT_DISCOVERY_RUNNER_POLL_INTERVAL_MS, handlerConfig?.pollIntervalMs || 2_000);
const concurrency = positiveInteger(process.env.COMPANY_REPORT_DISCOVERY_RUNNER_CONCURRENCY, handlerConfig?.concurrency || 1);
const runnerInstanceId = `company-report-discovery-runner:${randomUUID()}`;

if (selectCompanyReportDiscoveryTransport() === "openai" && !apiKey) {
  throw new Error("local company report discovery runner requires OPENAI_API_KEY or ~/.codex/auth.json when its transport is openai");
}

async function request(path, init) {
  const response = await fetchLocalRuntime(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== 200) throw new Error(body?.msg || `local company report discovery endpoint failed: ${response.status}`);
  return body.data;
}

function post(path, body) {
  return request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

export function buildCompanyReportDiscoveryWebSearch(response) {
  const metadata = response?.webSearch && typeof response.webSearch === "object"
    ? response.webSearch
    : {};
  const responseStatus = typeof response?.raw?.status === "string" ? response.raw.status : "";
  const webSearchCall = inspectWebSearchCall(response?.raw);
  // The shared Responses parser retains normalized `searched` metadata but
  // some completed responses omit the final web_search_call item from `raw`.
  // A completed response plus that provider-normalized signal is still a
  // completed search; incomplete/no-search responses remain rejected below.
  const webSearchCallCompleted = webSearchCall.completed
    || (responseStatus === "completed" && metadata.searched === true);
  return {
    searched: metadata.searched === true || webSearchCall.seen,
    queries: Array.isArray(metadata.queries) ? metadata.queries : [],
    citations: Array.isArray(metadata.citations) ? metadata.citations : [],
    responseCompleted: responseStatus === "completed",
    responseStatus,
    webSearchCallCompleted,
  };
}

function inspectWebSearchCall(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return { seen: false, completed: false };
  if (seen.has(value)) return { seen: false, completed: false };
  seen.add(value);
  if (Array.isArray(value)) {
    return value.reduce((result, item) => mergeWebSearchCallState(result, inspectWebSearchCall(item, seen)), { seen: false, completed: false });
  }
  const node = value;
  const type = typeof node.type === "string" ? node.type : "";
  const isCall = type === "web_search_call" || type.startsWith("response.web_search_call.");
  const status = typeof node.status === "string" ? node.status : "";
  const state = {
    seen: isCall,
    completed: isCall && (type === "response.web_search_call.completed" || status === "completed" || status === "complete"),
  };
  for (const child of Object.values(node)) {
    mergeWebSearchCallState(state, inspectWebSearchCall(child, seen));
  }
  return state;
}

function mergeWebSearchCallState(target, source) {
  target.seen ||= source.seen;
  target.completed ||= source.completed;
  return target;
}

function selectCompanyReportDiscoveryTransport() {
  return selectGenericLlmExecutionTransport(executionConfig, {
    handlerKey: "company_report_discovery",
    taskType: "company_report_discovery",
  });
}

function webQaAnswerText(snapshot) {
  return typeof snapshot?.answer?.content?.markdown === "string" ? snapshot.answer.content.markdown : "";
}

/** WebQA exposes browser answer sources instead of Responses tool events. */
export function buildCompanyReportDiscoveryWebQaSearch(snapshot) {
  const answer = snapshot?.answer && typeof snapshot.answer === "object" ? snapshot.answer : {};
  const records = [
    ...(Array.isArray(answer.citations) ? answer.citations : []),
    ...(Array.isArray(answer.sources) ? answer.sources : []),
  ];
  const seen = new Set();
  const citations = records.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const url = String(item.url || item.href || item.source_url || "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return [];
    seen.add(url);
    const title = String(item.title || item.name || url).trim() || url;
    return [{ title, url }];
  });
  return {
    // WebQA is the requested browser-backed research transport.  It does not
    // expose Responses `web_search_call` events, so its completed task is the
    // terminal provider signal for this explicit discovery operation.
    searched: snapshot?.status === "completed",
    queries: [],
    citations,
    responseCompleted: snapshot?.status === "completed",
    responseStatus: snapshot?.status || "",
    webSearchCallCompleted: snapshot?.status === "completed",
    transport: "webqa",
  };
}

export function webQaJob(job) {
  return {
    ...job,
    // A user-triggered force requeue is a new discovery attempt. Reusing a
    // gateway task that has already reached failed/cancelled would only replay
    // its old terminal error and never send the requested new search.
    idempotencyKey: `${job.idempotencyKey}:attempt:${job.attempt}`,
    rawModelRequest: {
      model: job.model,
      reasoningEffort: job.reasoningEffort,
      instructions: job.instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: job.input }] }],
    },
  };
}

export async function runJob(job, owner = runnerInstanceId) {
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    void post(`/api/company/report-discovery-runs/${encodeURIComponent(job.runId)}/heartbeat`, {
      taskId: job.taskId,
      runnerInstanceId: owner,
      attempt: job.attempt,
    }).catch(() => {});
  }, 10_000);
  localRuntimeLog("company-report-discovery", "started", {
    task_id: job.taskId,
    run_id: job.runId,
    attempt: job.attempt,
    security_code: job.securityCode,
  });
  try {
    const transport = selectCompanyReportDiscoveryTransport();
    if (transport === "webqa") {
      await runWebQaJob(webQaJob(job), owner, {
        config: { ...executionConfig.webqa, taskTimeoutMs: job.jobTimeoutMs },
        runtimePost: post,
        onCompleted: async ({ snapshot }) => post(`/api/company/report-discovery-runs/${encodeURIComponent(job.runId)}/complete`, {
          taskId: job.taskId,
          model: job.model,
          text: webQaAnswerText(snapshot),
          webSearch: buildCompanyReportDiscoveryWebQaSearch(snapshot),
          runnerInstanceId: owner,
          attempt: job.attempt,
        }),
      });
    } else {
      const provider = createLocalJobProvider(apiKey);
      const response = await provider.generate({
        model: job.model,
        instructions: job.instructions,
        input: [{ role: "user", content: [{ type: "input_text", text: job.input }] }],
        ...(job.reasoningEffort ? { reasoningEffort: job.reasoningEffort } : {}),
        tools: [{ type: "web_search", searchContextSize: "high" }],
        toolChoice: "required",
        maxOutputTokens: job.maxOutputTokens,
        signal: AbortSignal.timeout(job.jobTimeoutMs),
      });
      await post(`/api/company/report-discovery-runs/${encodeURIComponent(job.runId)}/complete`, {
        taskId: job.taskId,
        model: job.model,
        text: response.text,
        webSearch: buildCompanyReportDiscoveryWebSearch(response),
        runnerInstanceId: owner,
        attempt: job.attempt,
      });
    }
    localRuntimeLog("company-report-discovery", "completed", {
      task_id: job.taskId,
      run_id: job.runId,
      attempt: job.attempt,
      security_code: job.securityCode,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await post(`/api/company/report-discovery-runs/${encodeURIComponent(job.runId)}/fail`, {
        taskId: job.taskId,
        error: message,
        runnerInstanceId: owner,
        attempt: job.attempt,
      });
    } catch (failure) {
      localRuntimeError("company-report-discovery", "failure_persist_failed", failure, {
        task_id: job.taskId,
        run_id: job.runId,
        attempt: job.attempt,
      });
    }
    localRuntimeLog("company-report-discovery", "failed", {
      task_id: job.taskId,
      run_id: job.runId,
      attempt: job.attempt,
      security_code: job.securityCode,
      duration_ms: Date.now() - startedAt,
      error: message,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

export function startCompanyReportDiscoveryRunner() {
  let accepting = true;
  let polling = false;
  const active = new Set();
  const poll = async () => {
    if (!accepting || polling) return;
    polling = true;
    try {
      while (accepting && active.size < concurrency) {
        const claimed = await post("/api/company/report-discovery-tasks/claim-next", { runnerInstanceId });
        if (!claimed?.request?.securityCode) break;
        let work;
        work = runJob(claimed.request).finally(() => {
          active.delete(work);
          void poll();
        });
        active.add(work);
      }
    } catch (error) {
      localRuntimeError("company-report-discovery", "claim_failed", error);
    } finally {
      polling = false;
    }
  };
  localRuntimeLog("company-report-discovery", "polling_started", {
    runner_instance_id: runnerInstanceId,
    concurrency,
    base_url: baseUrl,
    poll_interval_ms: pollIntervalMs,
  });
  void poll();
  const timer = setInterval(() => void poll(), pollIntervalMs);
  return {
    async stop({ gracefulTimeoutMs = runtimeConfig?.lease?.gracefulShutdownMs || 30_000 } = {}) {
      accepting = false;
      clearInterval(timer);
      await Promise.race([
        Promise.allSettled([...active]),
        new Promise((resolve) => setTimeout(resolve, gracefulTimeoutMs)),
      ]);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = startCompanyReportDiscoveryRunner();
  const stop = () => { void controller.stop().finally(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
