import { taskdCallerClient, type TaskdTask, type TaskdTaskStatus } from "./taskd-client";
import {
  createGenericLlmTask,
  loadGenericLlmRun,
  loadGenericLlmRunArtifacts,
  loadGenericLlmTask,
  normalizeGenericLlmPriority,
  GENERIC_LLM_RAW_MODEL_ARTIFACT_STEP,
  GENERIC_LLM_RAW_MODEL_HANDLER_KEY,
  GENERIC_LLM_RAW_MODEL_TASK_TYPE,
  type GenericRawModelRequest,
} from "./local-job-protocol";
import type { Bindings } from "../types";

/** taskd currently routes explicit discovery requests through input-gateway's ChatGPT WebQA executor. */
const TASKD_WEBQA_TASK_TYPE = "webqa.chatgpt.v1";

export type SupportedLlmModel = "gpt-5.4-mini" | "gpt-5.6-luna";

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmTextRequest = {
  /** Retained as business audit metadata. taskd's current executor is ChatGPT WebQA. */
  model: SupportedLlmModel;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  cacheTtlMs?: number;
  cacheEnabled?: boolean;
  webSearch?: {
    searchContextSize?: "low" | "medium" | "high";
    allowedDomains?: string[];
    required?: boolean;
  };
  /**
   * Business task name. Re-submitting the same name deliberately creates a
   * newer taskd task and supersedes stale work; it is not an idempotency key.
   */
  idempotencyKey?: string;
  targetType?: string;
  targetId?: string;
  promptVersion?: string;
  requestId?: string;
  priority?: number | null;
  originTaskType?: string;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
  stream?: boolean;
  onText?: (delta: string) => Promise<void> | void;
  onStatus?: (status: "queued" | "running" | "completed" | "failed" | "blocked") => Promise<void> | void;
  signal?: AbortSignal;
};

export type LlmWebSearchMetadata = {
  searched: boolean;
  queries: string[];
  citations: Array<{ title: string; url: string; start?: number; end?: number }>;
};

export type LlmTextResponse = {
  model: SupportedLlmModel;
  text: string;
  cached: boolean;
  webSearch?: LlmWebSearchMetadata;
  raw: unknown;
};

export async function requestLlmText(env: Bindings, request: LlmTextRequest): Promise<LlmTextResponse> {
  assertLocalLlmRuntime(env);
  const provider = providerForModel(request.model);
  const { instructions, input } = normalizeMessages(request.messages);
  const rawRequest: GenericRawModelRequest = {
    provider,
    model: request.model,
    ...(request.requestId ? { requestId: request.requestId } : {}),
    instructions,
    input,
    temperature: request.temperature ?? 0,
    maxOutputTokens: request.maxTokens ?? 2048,
    ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    ...(request.cacheTtlMs !== undefined ? { cacheTtlMs: request.cacheTtlMs } : {}),
    ...(request.cacheEnabled !== undefined ? { cacheEnabled: request.cacheEnabled } : {}),
    stream: request.stream !== false || Boolean(request.onText),
    ...(request.webSearch ? {
      tools: [{ type: "web_search", searchContextSize: request.webSearch.searchContextSize ?? "high", ...(request.webSearch.allowedDomains?.length ? { filters: { allowedDomains: request.webSearch.allowedDomains } } : {}) }],
      toolChoice: request.webSearch.required === false ? "auto" as const : "required" as const,
    } : {}),
  };
  const targetType = text(request.targetType) || "llm_request";
  const targetId = text(request.targetId) || text(request.requestId) || `request:${crypto.randomUUID()}`;
  const promptVersion = text(request.promptVersion) || "generic-raw-model.v1";
  const idempotencyKey = text(request.idempotencyKey) || `generic-raw:${targetId}:${crypto.randomUUID()}`;
  const originTaskType = text(request.originTaskType);
  const created = await createGenericLlmTask(env.DB, {
    taskType: GENERIC_LLM_RAW_MODEL_TASK_TYPE,
    targetType,
    targetId,
    idempotencyKey,
    promptVersion,
    handlerKey: GENERIC_LLM_RAW_MODEL_HANDLER_KEY,
    model: request.model,
    reasoningEffort: request.reasoningEffort ?? null,
    priority: normalizeGenericLlmPriority(request.priority),
    metadata: { rawModelRequest: rawRequest, ...(originTaskType ? { originTaskType } : {}) },
  });
  return await awaitGenericLlmText(env.DB, created.task.taskId, request);
}

export async function awaitGenericLlmText(
  db: D1Database,
  taskId: string,
  options: Pick<LlmTextRequest, "model" | "pollIntervalMs" | "waitTimeoutMs" | "onText" | "onStatus">,
): Promise<LlmTextResponse> {
  const pollIntervalMs = boundedPositive(options.pollIntervalMs, 250, 5_000);
  const waitTimeoutMs = boundedPositive(options.waitTimeoutMs, 15 * 60_000, 24 * 60 * 60_000);
  const deadline = Date.now() + waitTimeoutMs;
  let emittedText = "";
  let callbackHealthy = Boolean(options.onText);
  let statusCallbackHealthy = Boolean(options.onStatus);
  let previousStatus: string | null = null;
  while (Date.now() <= deadline) {
    const task = await loadGenericLlmTask(db, taskId);
    if (!task) throw new Error(`generic LLM task not found: ${taskId}`);
    if (statusCallbackHealthy && options.onStatus && task.status !== previousStatus) {
      previousStatus = task.status;
      try { await options.onStatus(task.status); } catch { statusCallbackHealthy = false; }
    }
    const run = task.lastRunId ? await loadGenericLlmRun(db, task.lastRunId) : null;
    const artifacts = run ? await loadGenericLlmRunArtifacts(db, run.runId) : [];
    const latestPartial = artifacts.filter((artifact) => artifact.stepKey === GENERIC_LLM_RAW_MODEL_ARTIFACT_STEP && artifact.status === "partial").at(-1);
    const partialText = text(record(latestPartial?.output)?.text);
    if (callbackHealthy && options.onText && partialText) {
      const delta = partialText.startsWith(emittedText) ? partialText.slice(emittedText.length) : partialText;
      if (delta) {
        emittedText = partialText.startsWith(emittedText) ? partialText : `${emittedText}${partialText}`;
        try { await options.onText(delta); } catch { callbackHealthy = false; }
      }
    }
    if (["completed", "failed", "blocked"].includes(task.status)) {
      if (task.status !== "completed") throw new Error(task.lastErrorMessage || run?.errorMessage || `generic LLM task ${task.status}`);
      const terminal = artifacts.find((artifact) => artifact.stepKey === GENERIC_LLM_RAW_MODEL_ARTIFACT_STEP && artifact.status === "complete");
      const output = record(terminal?.output);
      const resultText = text(output?.text) || emittedText;
      if (!resultText && !output) throw new Error("generic LLM task completed without a terminal artifact");
      return {
        model: (text(output?.model) || options.model || text(run?.model)) as SupportedLlmModel,
        text: resultText,
        cached: output?.cached === true,
        webSearch: normalizeWebSearch(output?.webSearch),
        raw: output?.raw ?? null,
      };
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`generic LLM task wait timed out: ${taskId}`);
}

type TaskdGet = (name: string) => Promise<TaskdTask | null>;

export async function awaitTaskdLlmText(
  get: TaskdGet,
  name: string,
  initial: TaskdTask,
  options: Pick<LlmTextRequest, "model" | "pollIntervalMs" | "waitTimeoutMs" | "onText" | "onStatus">,
): Promise<LlmTextResponse> {
  const pollIntervalMs = boundedPositive(options.pollIntervalMs, 1_000, 5_000);
  const waitTimeoutMs = boundedPositive(options.waitTimeoutMs, 15 * 60_000, 24 * 60 * 60_000);
  const deadline = Date.now() + waitTimeoutMs;
  let task = initial;
  let previousStatus: TaskdTaskStatus | null = null;
  let statusCallbackHealthy = Boolean(options.onStatus);
  while (Date.now() <= deadline) {
    if (statusCallbackHealthy && options.onStatus && task.status !== previousStatus) {
      previousStatus = task.status;
      try { await options.onStatus(localStatus(task.status)); } catch { statusCallbackHealthy = false; }
    }
    if (task.status === "succeeded") {
      const response = responseFromTaskdTask(task, options.model);
      // taskd deliberately exposes no text deltas. A caller that still has an
      // SSE UI receives one final text event, never persisted partial output.
      if (options.onText && response.text) await options.onText(response.text);
      return response;
    }
    if (task.status === "failed") throw new Error(task.errorMessage || `taskd task failed: ${name}`);
    if (task.status === "interrupted") throw new Error(`taskd task interrupted: ${name}`);
    if (task.status === "superseded") throw new Error(`taskd task superseded: ${name}`);
    await delay(pollIntervalMs);
    const latest = await get(name);
    if (!latest) throw new Error(`taskd task not found: ${name}`);
    task = latest;
  }
  throw new Error(`taskd task wait timed out: ${name}`);
}

export function taskdWebQaInput(env: Pick<Bindings, "TASKD_NAMESPACE">, request: LlmTextRequest, name: string): Record<string, unknown> {
  return {
    platform: env.TASKD_NAMESPACE || "stock-info",
    conversation_id: `stock-info:${name}`,
    provider: "chatgpt-web",
    input: renderPrompt(request.messages),
    ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    new_session: true,
    timeout_ms: boundedPositive(request.waitTimeoutMs, 60 * 60_000, 24 * 60 * 60_000),
    mode: "ask",
  };
}

export function responseFromTaskdTask(task: TaskdTask, model: SupportedLlmModel): LlmTextResponse {
  const result = record(task.result);
  const text = string(result?.markdown);
  if (!text) throw new Error(`taskd succeeded task has no WebQA answer text: ${task.name}`);
  const citations = Array.isArray(result?.citations) ? result.citations : [];
  return {
    model,
    text,
    cached: false,
    webSearch: {
      searched: true,
      queries: [],
      citations: citations.flatMap(normalizeCitation),
    },
    raw: result,
  };
}

export function isLocalLlmRuntime(env: Pick<Bindings, "LLM_RUNTIME">): boolean {
  return env.LLM_RUNTIME === "local";
}

function taskName(request: LlmTextRequest): string {
  const explicit = string(request.idempotencyKey);
  if (explicit) return explicit;
  const targetType = string(request.targetType) || "llm_request";
  const targetId = string(request.targetId) || string(request.requestId) || crypto.randomUUID();
  const promptVersion = string(request.promptVersion) || "v1";
  return `${targetType}:${targetId}:${promptVersion}`;
}

function providerForModel(model: SupportedLlmModel): "openai" {
  if (model === "gpt-5.4-mini" || model === "gpt-5.6-luna") return "openai";
  throw new Error(`unsupported llm model: ${model}`);
}

function normalizeMessages(messages: LlmMessage[]): {
  instructions: string;
  input: Array<{ role: "user" | "assistant" | "system"; content: Array<{ type: "input_text"; text: string }> }>;
} {
  const systemMessages = messages.filter((item) => item.role === "system").map((item) => item.content.trim()).filter(Boolean);
  const conversational = messages.filter((item) => item.role !== "system").map((item) => ({
    role: item.role,
    content: [{ type: "input_text" as const, text: item.content }],
  }));
  return {
    instructions: systemMessages.join("\n\n"),
    input: conversational.length > 0 ? conversational : [{ role: "user", content: [{ type: "input_text", text: "" }] }],
  };
}

function renderPrompt(messages: LlmMessage[]): string {
  const rendered = messages
    .map((message) => ({ role: message.role, content: string(message.content) }))
    .filter((message) => message.content)
    // taskd's ChatGPT WebQA executor accepts one browser-composer string, not
    // a role-aware API request. Preserve message order, but do not imply that
    // a "system" entry has higher-priority semantics in that transport.
    .map((message) => message.content);
  if (rendered.length === 0) throw new Error("LLM request requires at least one non-empty message");
  return rendered.join("\n\n");
}

function localStatus(status: TaskdTaskStatus): "queued" | "running" | "completed" | "failed" | "blocked" {
  if (status === "queued" || status === "leased") return "queued";
  if (status === "running") return "running";
  if (status === "succeeded") return "completed";
  return status === "failed" ? "failed" : "blocked";
}

function normalizeCitation(value: unknown): Array<{ title: string; url: string; start?: number; end?: number }> {
  const item = record(value);
  const title = string(item?.title);
  const url = string(item?.url);
  return title && url ? [{ title, url }] : [];
}

function assertLocalLlmRuntime(env: Pick<Bindings, "LLM_RUNTIME">): void {
  if (!isLocalLlmRuntime(env)) throw new Error("LLM calls are disabled outside local Node development");
}

function boundedPositive(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function string(value: unknown): string { return text(value); }

function normalizeWebSearch(value: unknown): LlmWebSearchMetadata | undefined {
  const item = record(value);
  if (!item || typeof item.searched !== "boolean" || !Array.isArray(item.queries) || !Array.isArray(item.citations)) return undefined;
  return {
    searched: item.searched,
    queries: item.queries.filter((query): query is string => typeof query === "string"),
    citations: item.citations.flatMap((citation) => normalizeCitation(citation)),
  };
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
