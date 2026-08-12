/**
 * Handler registry for the universal local dispatcher. Keys are persisted in
 * workflow_tasks.handler_key; task_type is only the compatibility fallback for
 * rows created before the scheduler foundation.
 */
export const GENERIC_LLM_HANDLER_KEYS = Object.freeze([
  "generic_raw_model",
  "information_processing",
]);

const handlers = new Map([
  ["generic_raw_model", {
    key: "generic_raw_model",
    module: "../generic-llm-raw-runner.mjs",
    family: "generic-raw-model",
  }],
  ["information_processing", {
    key: "information_processing",
    module: "../information-processing-runner.mjs",
    family: "knowledge",
  }],
]);

export function selectGenericLlmHandler(taskOrHandlerKey) {
  const key = typeof taskOrHandlerKey === "string"
    ? taskOrHandlerKey.trim()
    : String(taskOrHandlerKey?.handlerKey || taskOrHandlerKey?.taskType || "").trim();
  return handlers.get(key) || null;
}

export function listGenericLlmHandlers() {
  return [...handlers.values()].map((handler) => ({ ...handler }));
}

export async function runGenericLlmHandler(handler, request, runnerInstanceId) {
  if (!handler || typeof handler.module !== "string") throw new Error("unknown generic LLM handler");
  const loaded = await import(handler.module);
  if (typeof loaded.runJob !== "function") throw new Error(`generic LLM handler ${handler.key} has no runJob adapter`);
  return loaded.runJob(request, runnerInstanceId);
}
