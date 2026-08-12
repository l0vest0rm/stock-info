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
  submit(input: { name: string; taskType: string; payload: unknown }): Promise<TaskdTask>;
  get(name: string): Promise<TaskdTask | null>;
  cancel(name: string): Promise<TaskdTask | null>;
  delete(name: string): Promise<boolean>;
};

type TaskdCallerClientOptions = {
  baseUrl: string;
  namespace: string;
  token: string;
  fetchImpl?: typeof fetch;
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
  const fetchImpl = options.fetchImpl || fetch;
  const prefix = `${baseUrl}/v1/namespaces/${encodeURIComponent(namespace)}/tasks`;

  async function request(path: string, init: RequestInit = {}): Promise<{ response: Response; body: unknown }> {
    let response: Response;
    try {
      response = await fetchImpl(`${prefix}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      throw new Error(`taskd request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body = await response.json().catch(() => null);
    return { response, body };
  }

  async function taskRequest(path: string, init?: RequestInit): Promise<TaskdTask | null> {
    const { response, body } = await request(path, init);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`taskd returned ${response.status}: ${message(body) || response.statusText}`);
    return normalizeTask(body);
  }

  return {
    async submit(input) {
      const name = required(input.name, "taskd task name");
      const taskType = required(input.taskType, "taskd task type");
      const task = await taskRequest("", {
        method: "POST",
        body: JSON.stringify({ client_task_name: name, task_type: taskType, input: input.payload }),
      });
      if (!task) throw new Error("taskd submit returned no task");
      return task;
    },
    get(name) {
      return taskRequest(`/by-name/${encodeURIComponent(required(name, "taskd task name"))}`);
    },
    cancel(name) {
      return taskRequest(`/by-name/${encodeURIComponent(required(name, "taskd task name"))}/cancel`, { method: "POST" });
    },
    async delete(name) {
      const { response, body } = await request(`/by-name/${encodeURIComponent(required(name, "taskd task name"))}`, { method: "DELETE" });
      if (response.status === 404) return false;
      if (response.status !== 204) throw new Error(`taskd returned ${response.status}: ${message(body) || response.statusText}`);
      return true;
    },
  };
}

export function taskdCallerClient(env: Bindings): TaskdCallerClient {
  if (env.LLM_RUNTIME !== "local") throw new Error("taskd caller is only available in local LLM runtime");
  return createTaskdCallerClient({
    baseUrl: env.TASKD_BASE_URL || "",
    namespace: env.TASKD_NAMESPACE || "stock-info",
    token: env.STOCK_INFO_TASKD_CALLER_TOKEN || "",
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

function message(value: unknown): string {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  return text(row?.error) || text(row?.message);
}
