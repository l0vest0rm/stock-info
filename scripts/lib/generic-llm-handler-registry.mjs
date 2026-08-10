/**
 * Handler registry for the universal local dispatcher. Keys are persisted in
 * llm_tasks.handler_key; task_type is only the compatibility fallback for
 * rows created before the scheduler foundation.
 */
export const GENERIC_LLM_HANDLER_KEYS = Object.freeze([
  "generic_raw_model",
  "company_report_discovery",
  "information_processing",
  "research_web_search",
  "research_operating_analysis",
  "research_operating_analysis_low_dependency",
  "research_operating_analysis_low_dependency_coordinator",
  "research_operating_analysis_low_dependency_stage",
]);

const handlers = new Map([
  ["generic_raw_model", {
    key: "generic_raw_model",
    module: "../generic-llm-raw-runner.mjs",
    family: "generic-raw-model",
  }],
  ["company_report_discovery", {
    key: "company_report_discovery",
    module: "../company-report-discovery-runner.mjs",
    family: "company",
  }],
  ["information_processing", {
    key: "information_processing",
    module: "../information-processing-runner.mjs",
    family: "knowledge",
  }],
  ["research_web_search", {
    key: "research_web_search",
    module: "../research-web-search-package-runner.mjs",
    family: "research-web-search",
  }],
  ["research_operating_analysis", {
    key: "research_operating_analysis",
    module: "../research-operating-analysis-runner.mjs",
    family: "research-operating-analysis",
  }],
  ["research_operating_analysis_low_dependency", {
    key: "research_operating_analysis_low_dependency",
    module: "../research-operating-analysis-low-dependency-runner.mjs",
    family: "research-operating-analysis-low-dependency",
  }],
  ["research_operating_analysis_low_dependency_coordinator", {
    key: "research_operating_analysis_low_dependency_coordinator",
    module: "../research-operating-analysis-low-dependency-runner.mjs",
    family: "research-operating-analysis-low-dependency",
  }],
  ["research_operating_analysis_low_dependency_stage", {
    key: "research_operating_analysis_low_dependency_stage",
    module: "../research-operating-analysis-low-dependency-runner.mjs",
    family: "research-operating-analysis-low-dependency",
  }],
]);
const resourcePromises = new Map();

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
  if (handler.family === "research-operating-analysis-low-dependency") {
    let resources = resourcePromises.get(handler.family);
    if (!resources) {
      resources = loaded.createLowDependencyRunnerResources();
      resourcePromises.set(handler.family, resources);
    }
    const resolved = await resources;
    return loaded.runJob(request, resolved.config, resolved.client, new Map(), runnerInstanceId);
  }
  return loaded.runJob(request, runnerInstanceId);
}
