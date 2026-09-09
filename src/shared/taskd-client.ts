import { createTaskdCallerClient, type TaskdCallerClient } from "@m2ai/shared-taskd-client";
import type { Bindings } from "../types";

export * from "@m2ai/shared-taskd-client";

const TASKD_READ_RETRY_DELAYS_MS = [150] as const;

/** A task-state read is safe to retry; submits, recovery and cancellation are not. */
export function isTaskdReadUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /errorCode=(?:network_fetch_failed|timeout_error|abort_error)\b|\b(?:ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNRESET|ECONNREFUSED|Connect Timeout Error)\b/i.test(message);
}

export function taskdCallerClient(env: Bindings): TaskdCallerClient {
  if (env.LLM_RUNTIME !== "local") throw new Error("taskd caller is only available in local LLM runtime");
  const token = env.STOCK_INFO_TASKD_CALLER_TOKEN || env.TASKD_CALLER_TOKEN || "";
  if (!token) throw new Error("STOCK_INFO_TASKD_CALLER_TOKEN is required");
  const client = createTaskdCallerClient({
    baseUrl: env.TASKD_BASE_URL || "",
    namespace: env.TASKD_NAMESPACE || "stock-info",
    // TASKD_CALLER_TOKEN is taskd's generic caller-secret name. Keep the
    // stock-info name first so existing local credential files remain valid.
    token,
    tokenSource: env.STOCK_INFO_TASKD_CALLER_TOKEN ? "STOCK_INFO_TASKD_CALLER_TOKEN" : env.TASKD_CALLER_TOKEN ? "TASKD_CALLER_TOKEN" : "missing",
  });
  return {
    ...client,
    availability: (taskType) => retryTaskdRead(() => client.availability(taskType)),
    get: (name) => retryTaskdRead(() => client.get(name)),
  };
}

async function retryTaskdRead<T>(read: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TASKD_READ_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (!isTaskdReadUnavailable(error) || attempt === TASKD_READ_RETRY_DELAYS_MS.length) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, TASKD_READ_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
