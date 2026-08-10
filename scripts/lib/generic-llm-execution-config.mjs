import { readFile } from "node:fs/promises";

const DEFAULT_CONFIG_URL = new URL("../../config/generic-llm-execution.json", import.meta.url);
const TRANSPORTS = new Set(["openai", "webqa"]);

export async function loadGenericLlmExecutionConfig({ path, env = process.env } = {}) {
  const source = path || env.GENERIC_LLM_EXECUTION_CONFIG || DEFAULT_CONFIG_URL;
  let value;
  try {
    value = JSON.parse(await readFile(source, "utf8"));
  } catch (error) {
    throw new Error(`generic LLM execution config could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeGenericLlmExecutionConfig(value);
}

export function normalizeGenericLlmExecutionConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("generic LLM execution config must be an object");
  }
  const config = value;
  const transport = normalizeTransport(config.executionTransport || config.transport || "openai");
  const handlerTransports = normalizeHandlerTransports(config.handlerTransports);
  const taskTypeTransports = normalizeHandlerTransports(config.taskTypeTransports);
  const originTaskTypeTransports = normalizeHandlerTransports(config.originTaskTypeTransports);
  const webqa = normalizeWebQaConfig(config.webqa);
  return {
    version: typeof config.version === "string" && config.version.trim() ? config.version.trim() : "generic-llm-execution.v1",
    transport,
    handlerTransports,
    taskTypeTransports,
    originTaskTypeTransports,
    webqa,
  };
}

export function selectGenericLlmExecutionTransport(config, { handlerKey, taskType, originTaskType } = {}) {
  // Nested generic raw tasks retain their own task type for lifecycle and
  // idempotency.  Only the immutable caller origin may opt them into a
  // different lower transport; an absent origin always falls back to the
  // generic raw task/handler rules.
  const originRule = matchingTaskTypeRule(config?.originTaskTypeTransports, originTaskType);
  const taskRule = matchingTaskTypeRule(config?.taskTypeTransports, taskType);
  const selected = originRule
    || taskRule
    || (handlerKey && config?.handlerTransports?.[handlerKey] ? config.handlerTransports[handlerKey] : config?.transport);
  return normalizeTransport(selected || "openai");
}

function matchingTaskTypeRule(rules, taskType) {
  const value = String(taskType || "").trim();
  if (!value || !rules || typeof rules !== "object") return null;
  if (rules[value]) return rules[value];
  const wildcard = Object.keys(rules)
    .filter((key) => key.endsWith("*") && value.startsWith(key.slice(0, -1)))
    .sort((left, right) => right.length - left.length)[0];
  return wildcard ? rules[wildcard] : null;
}

function normalizeTransport(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!TRANSPORTS.has(normalized)) throw new Error(`unsupported generic LLM execution transport: ${normalized || "<empty>"}`);
  return normalized;
}

function normalizeHandlerTransports(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("generic LLM handlerTransports must be an object");
  return Object.fromEntries(Object.entries(value).map(([key, transport]) => {
    const normalizedKey = String(key).trim();
    if (!normalizedKey) throw new Error("generic LLM handlerTransports contains an empty handler key");
    return [normalizedKey, normalizeTransport(transport)];
  }));
}

function normalizeWebQaConfig(value) {
  if (value === undefined || value === null) throw new Error("generic LLM WebQA config is required");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("generic LLM WebQA config must be an object");
  const baseUrl = String(value.gatewayBaseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("generic LLM WebQA gatewayBaseUrl is required");
  const provider = String(value.provider || "chatgpt-web").trim();
  const platform = String(value.platform || "stock-info").trim();
  if (!provider) throw new Error("generic LLM WebQA provider is required");
  if (!platform) throw new Error("generic LLM WebQA platform is required");
  return {
    gatewayBaseUrl: baseUrl,
    provider,
    platform,
    pollIntervalMs: positiveInteger(value.pollIntervalMs, 1200),
    taskTimeoutMs: positiveInteger(value.taskTimeoutMs, 1200000),
    cancelGraceMs: positiveInteger(value.cancelGraceMs, 30000),
    heartbeatIntervalMs: positiveInteger(value.heartbeatIntervalMs, 10000),
    reasoningEffort: String(value.reasoningEffort || "high").trim() || "high",
    newSession: value.newSession === true,
    singleTabMode: value.singleTabMode === true,
    attachments: normalizeAttachments(value.attachments),
  };
}

function normalizeAttachments(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("generic LLM WebQA attachments must be an array");
  return value.map((item) => {
    if (typeof item === "string" && item.trim()) return item.trim();
    if (item && typeof item === "object" && !Array.isArray(item) && typeof item.path === "string" && item.path.trim()) {
      return {
        path: item.path.trim(),
        ...(typeof item.name === "string" && item.name.trim() ? { name: item.name.trim() } : {}),
        ...(typeof item.mimeType === "string" && item.mimeType.trim() ? { mime_type: item.mimeType.trim() } : {}),
        ...(typeof item.mime_type === "string" && item.mime_type.trim() ? { mime_type: item.mime_type.trim() } : {}),
      };
    }
    throw new Error("generic LLM WebQA attachment must be a path or object with path");
  });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
