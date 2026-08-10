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

export type SupportedLlmModel = "gpt-5.4-mini" | "gpt-5.6-luna";

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmTextRequest = {
  model: SupportedLlmModel;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  cacheTtlMs?: number;
  cacheEnabled?: boolean;
  /** Web search is opt-in per explicit user task.  Callers must not attach it
   * to ordinary page reads or background refreshes. */
  webSearch?: {
    searchContextSize?: "low" | "medium" | "high";
    allowedDomains?: string[];
    required?: boolean;
  };
  /** Durable queue identity.  Callers with a natural id should provide it so
   * repeated requests deduplicate; omitted identities remain one-shot. */
  idempotencyKey?: string;
  targetType?: string;
  targetId?: string;
  promptVersion?: string;
  requestId?: string;
  priority?: number | null;
  /** Polling bounds apply to the request waiter only.  They never cancel the
   * queued/running task or its provider stream. */
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

export async function requestLlmText(
  env: Bindings,
  request: LlmTextRequest,
): Promise<LlmTextResponse> {
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
    metadata: { rawModelRequest: rawRequest },
  });
  return await awaitGenericLlmText(env.DB, created.task.taskId, {
    model: request.model,
    pollIntervalMs: request.pollIntervalMs,
    waitTimeoutMs: request.waitTimeoutMs,
    onText: request.onText,
    onStatus: request.onStatus,
  });
}

export type ScheduledLlmWaitOptions = {
  model?: SupportedLlmModel;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
  onText?: (delta: string) => Promise<void> | void;
  onStatus?: (status: "queued" | "running" | "completed" | "failed" | "blocked") => Promise<void> | void;
};

/** Read a raw/model task's persisted partial and terminal artifacts.  This
 * waiter intentionally never observes or forwards the caller's AbortSignal:
 * a dropped HTTP/SSE connection must not cancel durable model work. */
export async function awaitGenericLlmText(
  db: D1Database,
  taskId: string,
  options: ScheduledLlmWaitOptions = {},
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
    const partials = artifacts.filter((artifact) => artifact.stepKey === GENERIC_LLM_RAW_MODEL_ARTIFACT_STEP && artifact.status === "partial");
    const latestPartial = partials.at(-1);
    const latestPartialOutput = record(latestPartial?.output);
    const partialText = text(latestPartialOutput?.text);
    if (callbackHealthy && options.onText && partialText) {
      const delta = partialText.startsWith(emittedText) ? partialText.slice(emittedText.length) : partialText;
      if (delta) {
        emittedText = partialText.startsWith(emittedText) ? partialText : `${emittedText}${partialText}`;
        try { await options.onText(delta); } catch { callbackHealthy = false; }
      }
    }
    if (["completed", "failed", "blocked"].includes(task.status)) {
      if (task.status !== "completed") {
        throw new Error(task.lastErrorMessage || run?.errorMessage || `generic LLM task ${task.status}`);
      }
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
  // Timing out the waiter is deliberately non-terminal.  The dispatcher still
  // owns the task lease and a later reconnect can read its persisted state.
  throw new Error(`generic LLM task wait timed out: ${taskId}`);
}

export function isLocalLlmRuntime(env: Pick<Bindings, "LLM_RUNTIME">): boolean {
  return env.LLM_RUNTIME === "local";
}

function assertLocalLlmRuntime(env: Pick<Bindings, "LLM_RUNTIME">): void {
  if (!isLocalLlmRuntime(env)) {
    throw new Error("LLM calls are disabled outside local Node development");
  }
}

function providerForModel(model: SupportedLlmModel): "openai" {
  if (model === "gpt-5.4-mini" || model === "gpt-5.6-luna") {
    return "openai";
  }
  throw new Error(`unsupported llm model: ${model}`);
}

function normalizeMessages(messages: LlmMessage[]): {
  instructions: string;
  input: Array<{ role: "user" | "assistant" | "system"; content: Array<{ type: "input_text"; text: string }> }>;
} {
  const systemMessages = messages.filter((item) => item.role === "system").map((item) => item.content.trim()).filter(Boolean);
  const conversational = messages
    .filter((item) => item.role !== "system")
    .map((item) => ({
      role: item.role,
      content: [{ type: "input_text" as const, text: item.content }],
    }));
  return {
    instructions: systemMessages.join("\n\n"),
    input: conversational.length > 0 ? conversational : [{ role: "user", content: [{ type: "input_text", text: "" }] }],
  };
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

function normalizeWebSearch(value: unknown): LlmWebSearchMetadata | undefined {
  const item = record(value);
  if (!item || typeof item.searched !== "boolean" || !Array.isArray(item.queries) || !Array.isArray(item.citations)) return undefined;
  return { searched: item.searched, queries: item.queries.filter((query): query is string => typeof query === "string"), citations: item.citations.filter((citation): citation is { title: string; url: string; start?: number; end?: number } => Boolean(record(citation)?.title && record(citation)?.url)).map((citation) => ({ title: String(record(citation)?.title), url: String(record(citation)?.url), ...(Number.isFinite(record(citation)?.start) ? { start: Number(record(citation)?.start) } : {}), ...(Number.isFinite(record(citation)?.end) ? { end: Number(record(citation)?.end) } : {}) })) };
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
