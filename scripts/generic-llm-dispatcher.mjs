#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { fetchLocalRuntime } from "./lib/local-runtime-request.mjs";
import { localRuntimeError, localRuntimeLog } from "./lib/local-runtime-log.mjs";
import { runGenericLlmHandler, selectGenericLlmHandler } from "./lib/generic-llm-handler-registry.mjs";

const baseUrl = String(process.env.GENERIC_LLM_DISPATCHER_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const pollIntervalMs = positiveInteger(process.env.GENERIC_LLM_DISPATCHER_POLL_INTERVAL_MS, 1_000);
const runnerInstanceId = `generic-llm-dispatcher:${randomUUID()}`;

async function request(path, init) {
  const response = await fetchLocalRuntime(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== 200) throw new Error(body?.msg || `generic LLM dispatcher endpoint failed: ${response.status}`);
  return body.data;
}

function post(path, body) {
  return request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

async function failUnknownHandler(claim, message) {
  try {
    await post(`/api/llm-tasks/${encodeURIComponent(claim.run.runId)}/fail`, {
      taskId: claim.task.taskId,
      attempt: claim.run.attempt,
      runnerInstanceId,
      errorCode: "unknown_handler",
      error: message,
    });
  } catch (error) {
    localRuntimeError("generic-llm-dispatcher", "unknown_handler_persist_failed", error, { task_id: claim.task.taskId, run_id: claim.run.runId });
  }
}

async function runClaim(claim) {
  const handler = selectGenericLlmHandler(claim.handlerKey || claim.task?.handlerKey || claim.task?.taskType);
  if (!handler) {
    const message = `unknown generic LLM handler: ${claim.handlerKey || claim.task?.handlerKey || claim.task?.taskType || ""}`;
    await failUnknownHandler(claim, message);
    localRuntimeError("generic-llm-dispatcher", "unknown_handler", new Error(message), { task_id: claim.task?.taskId, run_id: claim.run?.runId });
    return;
  }
  const startedAt = Date.now();
  localRuntimeLog("generic-llm-dispatcher", "handler_started", { handler_key: handler.key, task_id: claim.task.taskId, run_id: claim.run.runId, attempt: claim.run.attempt });
  try {
    await runGenericLlmHandler(handler, claim.request, runnerInstanceId);
    localRuntimeLog("generic-llm-dispatcher", "handler_settled", { handler_key: handler.key, task_id: claim.task.taskId, run_id: claim.run.runId, attempt: claim.run.attempt, duration_ms: Date.now() - startedAt });
  } catch (error) {
    // Existing handler adapters persist their own fenced failure. Keep a
    // generic fallback for import/adapter failures so a slot is never leaked.
    const message = error instanceof Error ? error.message : String(error);
    await post(`/api/llm-tasks/${encodeURIComponent(claim.run.runId)}/fail`, { taskId: claim.task.taskId, attempt: claim.run.attempt, runnerInstanceId, errorCode: "handler_failed", error: message }).catch((failure) => localRuntimeError("generic-llm-dispatcher", "failure_persist_failed", failure, { task_id: claim.task.taskId, run_id: claim.run.runId }));
    localRuntimeError("generic-llm-dispatcher", "handler_failed", error, { handler_key: handler.key, task_id: claim.task.taskId, run_id: claim.run.runId, duration_ms: Date.now() - startedAt });
  }
}

export function startGenericLlmDispatcher() {
  let accepting = true;
  let polling = false;
  const active = new Set();
  const poll = async () => {
    if (!accepting || polling) return;
    polling = true;
    try {
      // The database provider ledger is the only model concurrency gate. Do
      // not add family caps or a local active-size admission check here.
      while (accepting) {
        const claim = await post("/api/llm-tasks/claim-next", { runnerInstanceId });
        if (!claim?.task || !claim?.run) break;
        if (["completed", "failed", "blocked"].includes(claim.request?.status)) continue;
        let work;
        work = runClaim(claim).finally(() => { active.delete(work); });
        active.add(work);
      }
    } catch (error) {
      localRuntimeError("generic-llm-dispatcher", "poll_failed", error);
    } finally {
      polling = false;
    }
  };
  localRuntimeLog("generic-llm-dispatcher", "polling_started", { runner_instance_id: runnerInstanceId, base_url: baseUrl, poll_interval_ms: pollIntervalMs });
  void poll();
  const timer = setInterval(() => void poll(), pollIntervalMs);
  return {
    async stop({ gracefulTimeoutMs = 30_000 } = {}) {
      accepting = false;
      clearInterval(timer);
      await Promise.race([Promise.allSettled([...active]), new Promise((resolve) => setTimeout(resolve, gracefulTimeoutMs))]);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = startGenericLlmDispatcher();
  const stop = () => { void controller.stop().finally(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
