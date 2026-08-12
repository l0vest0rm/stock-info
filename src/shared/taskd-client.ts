import { createTaskdCallerClient, type TaskdCallerClient } from "@m2ai/shared-taskd-client";
import type { Bindings } from "../types";

export * from "@m2ai/shared-taskd-client";

export function taskdCallerClient(env: Bindings): TaskdCallerClient {
  if (env.LLM_RUNTIME !== "local") throw new Error("taskd caller is only available in local LLM runtime");
  const token = env.STOCK_INFO_TASKD_CALLER_TOKEN || env.TASKD_CALLER_TOKEN || "";
  if (!token) throw new Error("STOCK_INFO_TASKD_CALLER_TOKEN is required");
  return createTaskdCallerClient({
    baseUrl: env.TASKD_BASE_URL || "",
    namespace: env.TASKD_NAMESPACE || "stock-info",
    // TASKD_CALLER_TOKEN is taskd's generic caller-secret name. Keep the
    // stock-info name first so existing local credential files remain valid.
    token,
    tokenSource: env.STOCK_INFO_TASKD_CALLER_TOKEN ? "STOCK_INFO_TASKD_CALLER_TOKEN" : env.TASKD_CALLER_TOKEN ? "TASKD_CALLER_TOKEN" : "missing",
  });
}
