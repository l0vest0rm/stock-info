import type { Bindings } from "../types";

export type TaskdTaskStatus = "queued" | "leased" | "running" | "cancel_requested" | "succeeded" | "failed" | "cancelled" | "superseded";

export type TaskdTask = {
  taskId: number;
  namespace: string;
  name: string;
  taskType: string;
  input: unknown;
  status: TaskdTaskStatus;
  checkpoint: unknown | null;
  result: unknown | null;
  errorMessage: string | null;
  supersededByTaskId: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type TaskdCallerClient = {
  submit(input: { name: string; taskType: string; payload: unknown; diagnostics?: Record<string, unknown> }): Promise<TaskdTask>;
  get(name: string): Promise<TaskdTask | null>;
  cancel(name: string): Promise<TaskdTask | null>;
  delete(name: string): Promise<boolean>;
};

type TaskdCallerClientOptions = {
  baseUrl: string;
  namespace: string;
  token: string;
  tokenSource?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/**
 * taskd's caller contract is deliberately name-only. A name is a business
 * identity, not a saved mapping to a remote task ID: repeated submit creates
 * a newer taskd execution and supersedes stale work for that name.
 */
export function createTaskdCallerClient(options: TaskdCallerClientOptions): TaskdCallerClient {
  const baseUrl = required(options.baseUrl, "TASKD_BASE_URL").replace(/\/+$/, "");
  const namespace = required(options.namespace, "TASKD_NAMESPACE");
  const token = required(options.token, "STOCK_INFO_TASKD_CALLER_TOKEN");
  const tokenSource = text(options.tokenSource) || "configured";
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const prefix = `${baseUrl}/v1/namespaces/${encodeURIComponent(namespace)}/tasks`;

  async function request(
    path: string,
    init: RequestInit = {},
    diagnostics: Record<string, unknown> = {},
  ): Promise<{ response: Response; body: unknown; rawText: string; requestedAt: string }> {
    let response: Response;
    const method = text(init.method) || "GET";
    const url = `${prefix}${path}`;
    const requestedAt = isoTimestamp(now());
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      throw new Error(`taskd request failed: ${requestErrorMessage(error)}${formatDiagnostics({
        method,
        url,
        namespace,
        tokenSource,
        token: maskToken(token),
        requestedAt,
        errorName: error instanceof Error ? error.name : undefined,
        errorCode: requestErrorCode(error),
        errorCause: errorCauseMessage(error),
        ...diagnostics,
      })}`);
    }
    const { body, rawText } = await parseTaskdResponseBody(response);
    return { response, body, rawText, requestedAt };
  }

  async function taskRequest(path: string, init?: RequestInit, diagnostics: Record<string, unknown> = {}): Promise<TaskdTask | null> {
    const { response, body, rawText, requestedAt } = await request(path, init, diagnostics);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`taskd returned ${response.status}: ${message(body, rawText) || response.statusText}${formatDiagnostics({
        status: response.status,
        statusText: response.statusText,
        requestedAt,
        responseCode: responseCode(body),
        responseReason: responseReason(body, rawText),
      })}`);
    }
    return normalizeTask(body);
  }

  return {
    async submit(input) {
      const name = required(input.name, "taskd task name");
      const taskType = required(input.taskType, "taskd task type");
      const task = await taskRequest("", {
        method: "POST",
        body: JSON.stringify({ client_task_name: name, task_type: taskType, input: input.payload }),
      }, {
        action: "submit",
        taskName: name,
        taskType,
        ...taskPayloadDiagnostics(input.payload),
        ...input.diagnostics,
      });
      if (!task) throw new Error("taskd submit returned no task");
      return task;
    },
    get(name) {
      const normalizedName = required(name, "taskd task name");
      return taskRequest(`/by-name/${encodeURIComponent(normalizedName)}`, undefined, { action: "get", taskName: normalizedName });
    },
    cancel(name) {
      const normalizedName = required(name, "taskd task name");
      return taskRequest(`/by-name/${encodeURIComponent(normalizedName)}/cancel`, { method: "POST" }, { action: "cancel", taskName: normalizedName });
    },
    async delete(name) {
      const normalizedName = required(name, "taskd task name");
      const { response, body, rawText, requestedAt } = await request(
        `/by-name/${encodeURIComponent(normalizedName)}`,
        { method: "DELETE" },
        { action: "delete", taskName: normalizedName },
      );
      if (response.status === 404) return false;
      if (response.status !== 204) {
        throw new Error(`taskd returned ${response.status}: ${message(body, rawText) || response.statusText}${formatDiagnostics({
          status: response.status,
          statusText: response.statusText,
          requestedAt,
          responseCode: responseCode(body),
          responseReason: responseReason(body, rawText),
        })}`);
      }
      return true;
    },
  };
}

export function taskdCallerClient(env: Bindings): TaskdCallerClient {
  if (env.LLM_RUNTIME !== "local") throw new Error("taskd caller is only available in local LLM runtime");
  const token = env.STOCK_INFO_TASKD_CALLER_TOKEN || env.TASKD_CALLER_TOKEN || "";
  return createTaskdCallerClient({
    baseUrl: env.TASKD_BASE_URL || "",
    namespace: env.TASKD_NAMESPACE || "stock-info",
    // TASKD_CALLER_TOKEN is taskd's generic caller-secret name. Keep the
    // stock-info name first so existing local credential files remain valid.
    token,
    tokenSource: env.STOCK_INFO_TASKD_CALLER_TOKEN ? "STOCK_INFO_TASKD_CALLER_TOKEN" : env.TASKD_CALLER_TOKEN ? "TASKD_CALLER_TOKEN" : "missing",
  });
}

function normalizeTask(value: unknown): TaskdTask {
  const row = record(value);
  const status = required(text(row.status), "taskd task status") as TaskdTaskStatus;
  if (!new Set<TaskdTaskStatus>(["queued", "leased", "running", "cancel_requested", "succeeded", "failed", "cancelled", "superseded"]).has(status)) {
    throw new Error(`taskd returned unsupported status: ${status}`);
  }
  return {
    taskId: integer(row.task_id, "taskd task_id"),
    namespace: required(text(row.namespace), "taskd namespace"),
    name: required(text(row.client_task_name), "taskd client_task_name"),
    taskType: required(text(row.task_type), "taskd task_type"),
    input: row.input,
    status,
    checkpoint: row.checkpoint ?? null,
    result: row.result ?? null,
    errorMessage: text(row.error_message) || null,
    supersededByTaskId: optionalInteger(row.superseded_by_task_id),
    createdAt: integer(row.created_at, "taskd created_at"),
    updatedAt: integer(row.updated_at, "taskd updated_at"),
    completedAt: optionalInteger(row.completed_at),
  };
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("taskd returned a non-object response");
  return value as Record<string, unknown>;
}

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

function integer(value: unknown, label: string): number {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 1) throw new Error(`${label} is invalid`);
  return numberValue;
}

function optionalInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return integer(value, "taskd integer");
}

async function parseTaskdResponseBody(response: Response): Promise<{ body: unknown; rawText: string }> {
  const rawText = await response.text().catch(() => "");
  const trimmed = rawText.trim();
  if (!trimmed) return { body: null, rawText: "" };
  try {
    return { body: JSON.parse(trimmed), rawText };
  } catch {
    return { body: null, rawText };
  }
}

function message(value: unknown, rawText = ""): string {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  return text(row?.error) || text(row?.message) || text(row?.reason) || truncateDiagnostic(rawText);
}

function responseCode(value: unknown): string {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  return text(row?.code) || text(row?.error_code) || text(row?.errorCode);
}

function responseReason(value: unknown, rawText = ""): string {
  return message(value, rawText);
}

function taskPayloadDiagnostics(value: unknown): Record<string, unknown> {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  return {
    provider: text(row?.provider) || undefined,
    platform: text(row?.platform) || undefined,
    conversationId: text(row?.conversation_id) || undefined,
    reasoningEffort: text(row?.reasoning_effort) || undefined,
    timeoutMs: numericDiagnostic(row?.timeout_ms),
    mode: text(row?.mode) || undefined,
  };
}

function numericDiagnostic(value: unknown): number | undefined {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function maskToken(value: string): string {
  if (!value) return "missing";
  if (value.length <= 8) return `present(len=${value.length})`;
  return `present(len=${value.length},last4=${value.slice(-4)})`;
}

function requestErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function requestErrorCode(error: unknown): string {
  const explicit = error && typeof error === "object" ? text((error as { code?: unknown }).code) : "";
  if (explicit) return explicit;
  const name = error instanceof Error ? error.name : "";
  const detail = requestErrorMessage(error);
  if (/fetch failed/i.test(detail)) return "network_fetch_failed";
  if (name === "AbortError") return "abort_error";
  if (name === "TimeoutError") return "timeout_error";
  return "";
}

function errorCauseMessage(error: unknown): string {
  const cause = error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause.trim() : "";
}

function truncateDiagnostic(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 160);
}

function isoTimestamp(value: number): string {
  return new Date(value).toISOString();
}

function formatDiagnostics(value: Record<string, unknown>): string {
  const parts = Object.entries(value)
    .flatMap(([key, item]) => {
      const normalized = diagnosticValue(item);
      return normalized ? [`${key}=${normalized}`] : [];
    });
  return parts.length ? ` [${parts.join(" ")}]` : "";
}

function diagnosticValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const normalized = typeof value === "string" ? truncateDiagnostic(value) : "";
  return normalized ? normalized.slice(0, 160) : "";
}
