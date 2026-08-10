/** Small HTTP client used by standalone Node scripts.  It talks to the same
 * local scheduler API as Worker request adapters, so all model work consumes
 * the durable global provider lease. */
export function createGenericLlmSchedulerClient({ baseUrl = "http://127.0.0.1:8000", pollIntervalMs = 500, waitTimeoutMs = 60 * 60_000 } = {}) {
  const root = String(baseUrl).replace(/\/+$/, "");
  async function request(path, init) {
    const response = await fetch(`${root}${path}`, init);
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.code !== 200) throw new Error(body?.msg || `generic LLM scheduler request failed: ${response.status}`);
    return body.data;
  }
  async function post(path, body) {
    return request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  async function requestText({ request: rawRequest, targetType = "llm_script", targetId, idempotencyKey, promptVersion = "generic-raw-model.v1", priority = 500, source, onText } = {}) {
    if (!rawRequest || typeof rawRequest !== "object") throw new Error("generic LLM request is required");
    const queued = await post("/api/llm-tasks", { request: rawRequest, targetType, targetId, idempotencyKey, promptVersion, priority, source });
    const taskId = queued?.task?.taskId;
    if (!taskId) throw new Error("generic LLM scheduler did not return a task id");
    const deadline = Date.now() + waitTimeoutMs;
    let emitted = "";
    let callbackHealthy = typeof onText === "function";
    while (Date.now() <= deadline) {
      const state = await request(`/api/llm-tasks/${encodeURIComponent(taskId)}`);
      const artifacts = Array.isArray(state?.artifacts) ? state.artifacts : [];
      const partial = artifacts.filter((item) => item?.stepKey === "raw_model" && item?.status === "partial").at(-1);
      const partialText = typeof partial?.output?.text === "string" ? partial.output.text : "";
      if (callbackHealthy && onText && partialText) {
        const delta = partialText.startsWith(emitted) ? partialText.slice(emitted.length) : partialText;
        if (delta) {
          emitted = partialText.startsWith(emitted) ? partialText : `${emitted}${partialText}`;
          try { await onText(delta); } catch { callbackHealthy = false; }
        }
      }
      emitted = partialText || emitted;
      const status = state?.task?.status;
      if (["completed", "failed", "blocked"].includes(status)) {
        if (status !== "completed") throw new Error(state?.task?.lastErrorMessage || state?.run?.errorMessage || `generic LLM task ${status}`);
        const terminal = artifacts.find((item) => item?.stepKey === "raw_model" && item?.status === "complete");
        const output = terminal?.output || {};
        return { ...output, text: typeof output.text === "string" && output.text ? output.text : emitted, taskId, task: state.task, run: state.run };
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error(`generic LLM task wait timed out: ${taskId}`);
  }
  return { requestText };
}

export function toGenericRawRequest({ provider = "openai", model, instructions, user, input, maxTokens, temperature, reasoningEffort, reasoningSummary, tools, toolChoice, cacheTtlMs, cacheEnabled, requestId } = {}) {
  return {
    provider,
    model,
    ...(requestId ? { requestId } : {}),
    ...(instructions ? { instructions } : {}),
    input: input || [{ role: "user", content: [{ type: "input_text", text: String(user || "") }] }],
    ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(reasoningSummary ? { reasoningSummary } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}),
    ...(cacheEnabled !== undefined ? { cacheEnabled } : {}),
    stream: true,
  };
}
