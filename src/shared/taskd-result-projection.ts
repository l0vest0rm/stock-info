import type { TaskdCallerClient, TaskdTask } from "./taskd-client";

export type TaskdProjection<T> = {
  name: string;
  project(task: TaskdTask): Promise<T>;
};

export type TaskdProjectionState<T> =
  | { state: "missing" }
  | { state: "pending"; task: TaskdTask }
  | { state: "failed"; task: TaskdTask }
  | { state: "superseded"; task: TaskdTask }
  | { state: "interrupted"; task: TaskdTask }
  | { state: "projected"; task: TaskdTask; value: T };

/**
 * Read taskd's latest task for one business name and project only a verified
 * terminal result. Callers must make `project` idempotent using their own
 * business unique keys. Repeating this function after a process crash is the
 * recovery path; it intentionally stores no generic local task state.
 */
export async function reconcileTaskdResult<T>(
  client: TaskdCallerClient,
  projection: TaskdProjection<T>,
): Promise<TaskdProjectionState<T>> {
  const task = await client.get(projection.name);
  if (!task) return { state: "missing" };
  switch (task.status) {
    case "succeeded":
      if (task.result === null) throw new Error(`taskd succeeded task ${task.name} has no result`);
      return { state: "projected", task, value: await projection.project(task) };
    case "failed":
      return { state: "failed", task };
    case "interrupted":
      return { state: "interrupted", task };
    case "superseded":
      return { state: "superseded", task };
    default:
      return { state: "pending", task };
  }
}
