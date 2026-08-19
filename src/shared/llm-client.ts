import type { TaskdTask, TaskdTaskStatus } from "./taskd-client";
import { extractTaskdWebQaResult } from "./taskd-webqa-result";
import type { Bindings } from "../types";

/** taskd currently routes explicit discovery requests through input-gateway's ChatGPT WebQA executor. */
export type SupportedLlmModel = "gpt-5.4-mini" | "gpt-5.6-luna";

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmTextRequest = {
  /** Retained as business audit metadata. taskd's current executor is ChatGPT WebQA. */
  model: SupportedLlmModel;
  messages: LlmMessage[];
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
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
  const result = extractTaskdWebQaResult(task.result);
  const text = string(result.content.markdown);
  if (!text) throw new Error(`taskd succeeded task has no WebQA answer text: ${task.name}`);
  return {
    model,
    text,
    cached: false,
    webSearch: {
      searched: true,
      queries: [],
      citations: result.citations.flatMap(normalizeCitation),
    },
    raw: result,
  };
}

export function isLocalLlmRuntime(env: Pick<Bindings, "LLM_RUNTIME">): boolean {
  return env.LLM_RUNTIME === "local";
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

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
