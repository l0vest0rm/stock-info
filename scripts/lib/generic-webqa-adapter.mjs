import { createHash } from "node:crypto";

export const WEBQA_ARTIFACT_STEP = "raw_model";
const WEBQA_STATUSES = new Set(["queued", "waiting_for_browser", "streaming", "finalizing", "recovering", "cancelling", "succeeded", "incomplete", "completed", "failed", "cancelled"]);
const DEFAULT_TASKD_TASK_TYPE = "webqa.chatgpt.v1";

/** A stable, user-visible error code that survives the generic runner boundary. */
export class WebQaAdapterError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "WebQaAdapterError";
    this.code = code;
  }
}

/**
 * The input-gateway returns the public task object directly (rather than the
 * local runtime's { code, data } envelope), so this client intentionally owns
 * only the gateway HTTP contract.
 */
export function createWebQaGatewayClient({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
  const root = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!root) throw new WebQaAdapterError("webqa_config_invalid", "WebQA gateway base URL is required");
  if (typeof fetchImpl !== "function") throw new WebQaAdapterError("webqa_config_invalid", "WebQA gateway fetch implementation is required");

  async function request(path, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new WebQaAdapterError("webqa_gateway_unavailable", `WebQA gateway request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = text(payload?.error) || text(payload?.msg) || `HTTP ${response.status}`;
      throw new WebQaAdapterError("webqa_gateway_http", `WebQA gateway returned ${response.status}: ${detail}`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new WebQaAdapterError("webqa_invalid_response", "WebQA gateway returned a non-object response");
    }
    return payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : payload;
  }

  return {
    submit: (body) => request("/api/webqa/tasks", { method: "POST", body }),
    get: (taskId) => request(`/api/webqa/tasks/${encodeURIComponent(taskId)}`),
    cancel: (taskId) => request(`/api/webqa/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", body: {} }),
  };
}

export function createWebQaTaskdClient({
  baseUrl,
  namespace,
  taskType = DEFAULT_TASKD_TASK_TYPE,
  bearerToken = process.env.STOCK_INFO_TASKD_CALLER_TOKEN || process.env.TASKD_CALLER_TOKEN || "",
  fetchImpl = globalThis.fetch,
} = {}) {
  const root = String(baseUrl || "").trim().replace(/\/+$/, "");
  const scopedNamespace = String(namespace || "").trim();
  const token = String(bearerToken || "").trim();
  if (!root) throw new WebQaAdapterError("webqa_config_invalid", "taskd base URL is required");
  if (!scopedNamespace) throw new WebQaAdapterError("webqa_config_invalid", "taskd namespace is required");
  if (!token) throw new WebQaAdapterError("webqa_config_invalid", "taskd caller token is required");
  if (typeof fetchImpl !== "function") throw new WebQaAdapterError("webqa_config_invalid", "taskd fetch implementation is required");

  async function request(path, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new WebQaAdapterError("webqa_gateway_unavailable", `taskd request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = text(payload?.error) || text(payload?.msg) || `HTTP ${response.status}`;
      throw new WebQaAdapterError("webqa_gateway_http", `taskd returned ${response.status}: ${detail}`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new WebQaAdapterError("webqa_invalid_response", "taskd returned a non-object response");
    }
    return payload;
  }

  const prefix = `/v1/namespaces/${encodeURIComponent(scopedNamespace)}/tasks`;
  return {
    submit: (clientTaskName, input) => request(prefix, {
      method: "POST",
      body: {
        task_type: taskType,
        client_task_name: clientTaskName,
        input,
      },
    }),
    get: (clientTaskName) => request(`${prefix}/by-name/${encodeURIComponent(clientTaskName)}`),
    cancel: (clientTaskName) => request(`${prefix}/by-name/${encodeURIComponent(clientTaskName)}/cancel`, { method: "POST", body: {} }),
  };
}

/**
 * Build one WebQA request from the existing generic raw-model request. The
 * business stage supplies only the normal instructions/input/identity; the
 * WebQA transport and session policy remain lower-layer configuration.
 */
export function buildWebQaRequest(job, config) {
  const rawModelRequest = readRawModelRequest(job);
  const identity = genericTaskIdentity(job);
  const prompt = renderGenericPrompt(rawModelRequest);
  if (!prompt) throw new WebQaAdapterError("webqa_input_missing", "generic raw model request has no text for WebQA");
  const session = deriveWebQaSession(identity, config);
  const reasoningEffort = text(job?.reasoningEffort) || text(rawModelRequest.reasoningEffort) || text(config.reasoningEffort);
  return {
    platform: config.platform,
    conversation_id: session.conversationId,
    provider: config.provider,
    input: prompt,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    attachments: config.attachments,
    new_session: config.newSession,
    single_tab_mode: config.singleTabMode,
    timeout_ms: config.taskTimeoutMs,
    mode: "ask",
    idempotency_key: session.idempotencyKey,
  };
}

export function deriveWebQaSession(identity, config) {
  const tuple = JSON.stringify({
    taskType: identity.taskType,
    targetType: identity.targetType,
    targetId: identity.targetId,
    idempotencyKey: identity.idempotencyKey,
    protocolVersion: identity.protocolVersion,
    promptVersion: identity.promptVersion,
  });
  const digest = createHash("sha256").update(tuple).digest("hex").slice(0, 32);
  const prefix = slug(config.platform || "stock-info");
  return {
    conversationId: `${prefix}-generic-${digest}`,
    idempotencyKey: `webqa-${digest}`,
  };
}

/** Keep only the structured snapshot in run progress; never persist answer text here. */
export function normalizeWebQaSnapshot(value) {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!item) throw new WebQaAdapterError("webqa_invalid_response", "WebQA task response is not an object");
  const status = text(item.status);
  const taskId = text(item.task_id);
  if (!status || !taskId) throw new WebQaAdapterError("webqa_invalid_response", "WebQA task response lacks task_id or status");
  if (!WEBQA_STATUSES.has(status)) throw new WebQaAdapterError("webqa_unknown_status", `WebQA gateway returned unsupported status: ${status}`);
  // The gateway deliberately stores `answer: null` until the provider has a
  // terminal result.  Requiring an answer while a task is queued/streaming
  // turns a valid accepted task into an immediate local failure.
  const answer = normalizeWebQaAnswer(item.answer, { required: status === "succeeded" });
  const terminalEvidence = normalizeTerminalEvidence(item.terminal_evidence);
  if (status === "succeeded" && !terminalEvidence) {
    throw new WebQaAdapterError("webqa_unverified_completion", "WebQA succeeded without completionEvidence.v1");
  }
  return {
    taskId,
    mode: text(item.mode),
    status,
    platform: text(item.platform),
    requestConversationId: text(item.conversation_id),
    provider: text(item.provider),
    idempotencyKey: text(item.idempotency_key),
    reasoningEffort: text(item.reasoning_effort),
    answer,
    terminalEvidence,
    providerConversationId: text(item.conversation_id_provider),
    providerUrl: text(item.provider_url),
    error: text(item.error),
    cancelRequested: item.cancel_requested === true,
    events: Array.isArray(item.events) ? item.events.slice(-8).map(normalizeEvent).filter(Boolean) : [],
    updatedAt: text(item.updated_at),
    raw: item,
  };
}

export function normalizeTaskdWebQaSnapshot(value, { clientTaskName } = {}) {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!item) throw new WebQaAdapterError("webqa_invalid_response", "taskd task response is not an object");
  const input = item.input && typeof item.input === "object" && !Array.isArray(item.input) ? item.input : {};
  const checkpoint = item.checkpoint && typeof item.checkpoint === "object" && !Array.isArray(item.checkpoint) ? item.checkpoint : {};
  const result = item.result && typeof item.result === "object" && !Array.isArray(item.result) ? item.result : {};
  const answer = normalizeWebQaAnswer(result.answer, { required: text(item.status) === "succeeded" });
  const terminalEvidence = normalizeTerminalEvidence(result.terminal_evidence || result.completionEvidence);
  if (text(item.status) === "succeeded" && !terminalEvidence) {
    throw new WebQaAdapterError("webqa_unverified_completion", "taskd completed WebQA task without completionEvidence.v1");
  }
  const status = mapTaskdStatus(item.status, checkpoint.gateway_status);
  if (!WEBQA_STATUSES.has(status)) {
    throw new WebQaAdapterError("webqa_unknown_status", `taskd returned unsupported mapped status: ${status}`);
  }
  const taskId = text(item.client_task_name) || text(clientTaskName);
  if (!taskId) throw new WebQaAdapterError("webqa_invalid_response", "taskd task response lacks client_task_name");
  const raw = answer?.rawSnapshot && typeof answer.rawSnapshot === "object" && !Array.isArray(answer.rawSnapshot)
    ? answer.rawSnapshot
    : result.rawSnapshot && typeof result.rawSnapshot === "object" && !Array.isArray(result.rawSnapshot)
      ? result.rawSnapshot
      : item;
  return {
    taskId,
    taskdTaskId: text(item.task_id),
    gatewayTaskId: text(checkpoint.gateway_task_id) || text(result.gateway_task_id),
    mode: text(input.mode || checkpoint.mode),
    status,
    platform: text(result.platform || checkpoint.platform || input.platform),
    requestConversationId: text(result.conversation_id || checkpoint.conversation_id || input.conversation_id),
    provider: text(result.provider || checkpoint.provider || input.provider),
    idempotencyKey: text(input.idempotency_key),
    reasoningEffort: text(result.reasoning_effort || checkpoint.reasoning_effort || input.reasoning_effort),
    answer,
    terminalEvidence,
    providerConversationId: text(result.provider_conversation_id || checkpoint.provider_conversation_id),
    providerUrl: text(result.provider_url || checkpoint.provider_url),
    error: text(item.error_message || result.error || checkpoint.error),
    cancelRequested: text(item.status) === "cancel_requested",
    events: [],
    updatedAt: text(result.updated_at || checkpoint.updated_at || item.updated_at),
    raw,
  };
}

function normalizeWebQaAnswer(value, { required = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (!required) return null;
    throw new WebQaAdapterError("webqa_invalid_response", "WebQA completed task lacks structured answer");
  }
  const formatVersion = text(value.formatVersion);
  const markdown = typeof value.content?.markdown === "string" ? value.content.markdown : "";
  if (formatVersion !== "webqa.answer.v1" || typeof value.content !== "object" || Array.isArray(value.content) || typeof value.content.markdown !== "string") {
    throw new WebQaAdapterError("webqa_invalid_response", "WebQA task response has an invalid structured answer");
  }
  if (!Array.isArray(value.citations) || !Array.isArray(value.sources) || !value.rawSnapshot || typeof value.rawSnapshot !== "object" || Array.isArray(value.rawSnapshot)) {
    throw new WebQaAdapterError("webqa_invalid_response", "WebQA structured answer must preserve citations, sources and rawSnapshot");
  }
  return {
    formatVersion,
    content: { markdown },
    citations: value.citations,
    sources: value.sources,
    rawSnapshot: value.rawSnapshot,
  };
}

function normalizeTerminalEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const signals = Array.isArray(value.signals) ? value.signals.map(text).filter(Boolean) : [];
  const evidence = {
    schemaVersion: text(value.schemaVersion),
    outcome: text(value.outcome),
    provider: text(value.provider),
    providerUrl: text(value.providerUrl),
    resultKind: text(value.resultKind),
    signals,
    contentSha256: text(value.contentSha256),
    contentChars: Number.isInteger(value.contentChars) && value.contentChars >= 0 ? value.contentChars : null,
    terminalAt: text(value.terminalAt),
  };
  if (evidence.schemaVersion !== "webqa.completion-evidence.v1" || evidence.outcome !== "succeeded" || !evidence.signals.length || !evidence.contentSha256 || !evidence.terminalAt) return null;
  return evidence;
}

function answerMarkdown(answer) {
  return typeof answer?.content?.markdown === "string" ? answer.content.markdown : "";
}

/**
 * Run one already-claimed generic run through input-gateway WebQA. `runtimePost`
 * is the existing local scheduler API bridge; injecting it keeps this adapter
 * independent from the Worker/Node transport and makes the lower boundary
 * testable without a browser.
 */
export async function runWebQaJob(job, owner, {
  config,
  runtimePost,
  gateway,
  sleep = delay,
  now = () => Date.now(),
  onCompleted,
} = {}) {
  const normalizedConfig = normalizeAdapterConfig(config);
  if (typeof runtimePost !== "function") throw new WebQaAdapterError("webqa_config_invalid", "WebQA runtime persistence callback is required");
  const isTaskd = Boolean(normalizedConfig.taskdBaseUrl);
  const client = gateway || (isTaskd
    ? createWebQaTaskdClient({
      baseUrl: normalizedConfig.taskdBaseUrl,
      namespace: normalizedConfig.taskdNamespace,
      taskType: normalizedConfig.taskdTaskType,
      bearerToken: process.env[normalizedConfig.taskdTokenEnv] || process.env.STOCK_INFO_TASKD_CALLER_TOKEN || process.env.TASKD_CALLER_TOKEN || "",
    })
    : createWebQaGatewayClient({ baseUrl: normalizedConfig.gatewayBaseUrl }));
  const externalFromProgress = readExternalProgress(job);
  const request = externalFromProgress?.taskId || externalFromProgress?.gatewayTaskId
    ? restoreExternalRequest(externalFromProgress, normalizedConfig)
    : buildWebQaRequest(job, normalizedConfig);
  // Older persisted progress names this immutable gateway identity
  // `gatewayTaskId`; the adapter accepts both spellings but always uses the
  // task id for GET-only recovery.
  let externalTaskId = text(externalFromProgress?.taskId || externalFromProgress?.gatewayTaskId);
  let latest = null;
  let leaseActive = true;
  let heartbeatBusy = false;

  const heartbeat = setInterval(() => {
    if (heartbeatBusy || !leaseActive) return;
    heartbeatBusy = true;
    void runtimePost(`/api/llm-tasks/${encodeURIComponent(job.runId)}/heartbeat`, {
      taskId: job.taskId,
      runnerInstanceId: owner,
      attempt: job.attempt,
    }).then((result) => {
      const active = result?.active ?? result?.data?.active;
      if (active === false) leaseActive = false;
    }).catch(() => {
      // The next heartbeat or the fenced progress write is authoritative.
    }).finally(() => { heartbeatBusy = false; });
  }, normalizedConfig.heartbeatIntervalMs);

  const persistProgress = async (snapshot, extra = {}) => {
    ensureLease(leaseActive);
    const state = {
      kind: "webqa",
      ...(normalizedConfig.gatewayBaseUrl ? { gatewayBaseUrl: normalizedConfig.gatewayBaseUrl } : {}),
      ...(normalizedConfig.taskdBaseUrl ? { taskdBaseUrl: normalizedConfig.taskdBaseUrl, taskdNamespace: normalizedConfig.taskdNamespace } : {}),
      taskId: externalTaskId,
      gatewayTaskId: externalTaskId,
      ...(text(snapshot?.taskdTaskId) ? { taskdTaskId: text(snapshot.taskdTaskId) } : {}),
      ...(text(snapshot?.gatewayTaskId) ? { executorGatewayTaskId: text(snapshot.gatewayTaskId) } : {}),
      platform: request.platform,
      conversationId: request.conversation_id,
      provider: request.provider,
      idempotencyKey: request.idempotency_key,
      mode: request.mode,
      reasoningEffort: request.reasoning_effort,
      gatewayStatus: snapshot?.status || extra.gatewayStatus || "submitted",
      providerUrl: snapshot?.providerUrl || extra.providerUrl || externalFromProgress?.providerUrl || "",
      providerConversationId: snapshot?.providerConversationId || extra.providerConversationId || externalFromProgress?.providerConversationId || "",
      answer: snapshot?.answer || externalFromProgress?.answer || null,
      answerLength: answerMarkdown(snapshot?.answer).length,
      cancelRequested: snapshot?.cancelRequested === true,
      lastEventAt: snapshot?.updatedAt || extra.lastEventAt || "",
      ...(extra.submittedAt ? { submittedAt: extra.submittedAt } : {}),
      ...(extra.recovered ? { recovered: true } : {}),
      ...(text(externalFromProgress?.recoveredFromRunId) ? { recoveredFromRunId: text(externalFromProgress.recoveredFromRunId) } : {}),
      ...(text(externalFromProgress?.recoveredFromTaskId) ? { recoveredFromTaskId: text(externalFromProgress.recoveredFromTaskId) } : {}),
    };
    const result = await runtimePost(`/api/llm-tasks/${encodeURIComponent(job.runId)}/progress`, {
      taskId: job.taskId,
      runnerInstanceId: owner,
      attempt: job.attempt,
      stepKey: WEBQA_ARTIFACT_STEP,
      metadata: { transport: "webqa", external: state },
    });
    const active = result?.active ?? result?.data?.active;
    if (active === false) {
      leaseActive = false;
      throw new WebQaAdapterError("webqa_lease_lost", "generic LLM run lease is no longer owned by this runner");
    }
  };

  try {
    if (!externalTaskId) {
      let submitted;
      try {
        const session = deriveWebQaSession(genericTaskIdentity(job), normalizedConfig);
        externalTaskId = session.idempotencyKey;
        const response = isTaskd
          ? await client.submit(externalTaskId, request)
          : await client.submit(request);
        submitted = isTaskd
          ? normalizeTaskdWebQaSnapshot(response, { clientTaskName: externalTaskId })
          : normalizeWebQaSnapshot(response);
      } catch (error) {
        throw asWebQaError(error, "webqa_submit_failed");
      }
      externalTaskId = submitted.taskId;
      latest = submitted;
      // This write happens before the first GET. A retry after a lease race
      // submits the same tuple and gateway idempotency returns this task.
      await persistProgress(submitted, { submittedAt: now() });
    }

    const deadline = now() + normalizedConfig.taskTimeoutMs;
    while (now() <= deadline) {
      ensureLease(leaseActive);
      try {
        const response = await client.get(externalTaskId);
        latest = isTaskd
          ? normalizeTaskdWebQaSnapshot(response, { clientTaskName: externalTaskId })
          : normalizeWebQaSnapshot(response);
      } catch (error) {
        const normalized = asWebQaError(error, "webqa_poll_failed");
        // The gateway persists the external task identity before this loop.
        // A brief gateway restart can therefore be retried safely: once it is
        // back, GET resumes the same browser-backed request rather than
        // creating a second provider turn. Other HTTP/contract failures stay
        // visible immediately instead of being hidden by a generic retry.
        if (isTransientGatewayUnavailable(normalized) && now() <= deadline) {
          await sleep(normalizedConfig.pollIntervalMs);
          continue;
        }
        throw normalized;
      }
      await persistProgress(latest);
      if (latest.status === "succeeded") {
        if (!answerMarkdown(latest.answer) && !hasGeneratedOutput(latest.raw)) {
          throw new WebQaAdapterError("webqa_empty_completion", "WebQA completed without structured answer or generated output");
        }
        assertArtifactContract(readRawModelRequest(job).artifactContract, latest);
        const terminalMetadata = terminalMetadataFor(latest, request, externalTaskId);
        if (typeof onCompleted === "function") {
          await onCompleted({ job, owner, snapshot: latest, request, externalTaskId, terminalMetadata });
          return { taskId: externalTaskId, snapshot: latest };
        }
        await runtimePost(`/api/llm-tasks/${encodeURIComponent(job.runId)}/artifact`, {
          taskId: job.taskId,
          runnerInstanceId: owner,
          attempt: job.attempt,
          stepKey: WEBQA_ARTIFACT_STEP,
          outputType: "json",
          status: "complete",
          output: {
            provider: latest.provider || request.provider,
            model: latest.provider || request.provider,
            text: answerMarkdown(latest.answer),
            answer: latest.answer,
            reasoningText: "",
            webSearch: null,
            raw: latest.raw,
            cached: false,
          },
          terminalMetadata,
        });
        await runtimePost(`/api/llm-tasks/${encodeURIComponent(job.runId)}/complete`, {
          taskId: job.taskId,
          runnerInstanceId: owner,
          attempt: job.attempt,
          status: "completed",
          metadata: terminalMetadata,
        });
        return { taskId: externalTaskId, snapshot: latest };
      }
      if (latest.status === "incomplete" || latest.status === "completed") {
        const code = latest.status === "completed" ? "webqa_legacy_completion_unverified" : "webqa_incomplete";
        await failRun(runtimePost, job, owner, code, latest.error || "WebQA stream ended without verified terminal evidence", terminalMetadataFor(latest, request, externalTaskId));
        return { taskId: externalTaskId, snapshot: latest };
      }
      if (latest.status === "failed") {
        await failRun(runtimePost, job, owner, stableGatewayError(latest.error, "webqa_provider_failed"), latest.error || "WebQA provider failed", terminalMetadataFor(latest, request, externalTaskId));
        return { taskId: externalTaskId, snapshot: latest };
      }
      if (latest.status === "cancelled") {
        await failRun(runtimePost, job, owner, "webqa_cancelled", latest.error || "WebQA task was cancelled", terminalMetadataFor(latest, request, externalTaskId));
        return { taskId: externalTaskId, snapshot: latest };
      }
      await sleep(normalizedConfig.pollIntervalMs);
    }

    // A bounded waiter timeout is visible and recoverable. Request provider
    // cancellation, then give the gateway a short grace window to confirm it.
    try {
      const response = await client.cancel(externalTaskId);
      latest = isTaskd
        ? normalizeTaskdWebQaSnapshot(response, { clientTaskName: externalTaskId })
        : normalizeWebQaSnapshot(response);
      await persistProgress(latest);
    } catch (error) {
      throw asWebQaError(error, "webqa_cancel_failed");
    }
    const cancelDeadline = now() + normalizedConfig.cancelGraceMs;
    while (now() <= cancelDeadline) {
      if (latest.status === "succeeded") {
        // The provider completed while cancellation was being requested; do
        // not discard a terminal answer.
        return await completeFromSnapshot({ latest, request, externalTaskId, job, owner, runtimePost, persistProgress, onCompleted });
      }
      if (latest.status === "cancelled") {
        await failRun(runtimePost, job, owner, "webqa_cancelled", latest.error || "WebQA task was cancelled after timeout", terminalMetadataFor(latest, request, externalTaskId));
        return { taskId: externalTaskId, snapshot: latest };
      }
      await sleep(normalizedConfig.pollIntervalMs);
      const response = await client.get(externalTaskId);
      latest = isTaskd
        ? normalizeTaskdWebQaSnapshot(response, { clientTaskName: externalTaskId })
        : normalizeWebQaSnapshot(response);
      await persistProgress(latest);
    }
    throw new WebQaAdapterError("webqa_cancel_timeout", `WebQA cancellation did not reach a terminal state: ${latest.status}`);
  } catch (error) {
    const normalized = asWebQaError(error, "webqa_provider_failed");
    if (normalized.code === "webqa_lease_lost") throw normalized;
    throw normalized;
  } finally {
    clearInterval(heartbeat);
  }
}

async function completeFromSnapshot({ latest, request, externalTaskId, job, owner, runtimePost, persistProgress, onCompleted }) {
  if (!answerMarkdown(latest.answer) && !hasGeneratedOutput(latest.raw)) throw new WebQaAdapterError("webqa_empty_completion", "WebQA completed without structured answer or generated output");
  assertArtifactContract(readRawModelRequest(job).artifactContract, latest);
  const terminalMetadata = terminalMetadataFor(latest, request, externalTaskId);
  if (typeof onCompleted === "function") {
    await onCompleted({ job, owner, snapshot: latest, request, externalTaskId, terminalMetadata });
    return { taskId: externalTaskId, snapshot: latest };
  }
  await runtimePost(`/api/llm-tasks/${encodeURIComponent(job.runId)}/artifact`, {
    taskId: job.taskId,
    runnerInstanceId: owner,
    attempt: job.attempt,
    stepKey: WEBQA_ARTIFACT_STEP,
    outputType: "json",
    status: "complete",
    output: { provider: latest.provider || request.provider, model: latest.provider || request.provider, text: answerMarkdown(latest.answer), answer: latest.answer, reasoningText: "", webSearch: null, raw: latest.raw, cached: false },
    terminalMetadata,
  });
  await runtimePost(`/api/llm-tasks/${encodeURIComponent(job.runId)}/complete`, { taskId: job.taskId, runnerInstanceId: owner, attempt: job.attempt, status: "completed", metadata: terminalMetadata });
  return { taskId: externalTaskId, snapshot: latest };
}

/** The provider terminal state and a caller-owned artifact contract are
 * separate gates. This generic validator deliberately knows only the declared
 * contract, never a business task type or provider/UI completion heuristic. */
function assertArtifactContract(contract, snapshot) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return;
  if (text(contract.kind) !== "markdown_h1") throw new WebQaAdapterError("webqa_artifact_contract_invalid", "unsupported WebQA artifact contract");
  const markdown = answerMarkdown(snapshot.answer).trim();
  const headings = markdown.match(/^#\s+.+$/gm) || [];
  const requiredH1Count = positiveInteger(contract.requiredH1Count, 0);
  const minimumCharacters = positiveInteger(contract.minimumCharacters, 0);
  const prefix = text(contract.requiredH1Prefix);
  const matchingHeadings = contract.numberedH1 === true
    ? headings.filter((heading) => /^#\s+[1-9]\d*\.\s+.+$/.test(heading))
    : prefix ? headings.filter((heading) => heading.startsWith(prefix)) : headings;
  if (markdown.length < minimumCharacters || (requiredH1Count > 0 && (matchingHeadings.length !== requiredH1Count || headings.length !== requiredH1Count))) {
    throw new WebQaAdapterError("webqa_artifact_contract_invalid", `WebQA Markdown artifact violates its contract: received ${markdown.length} characters and ${matchingHeadings.length}/${requiredH1Count} required H1 sections`);
  }
}

async function failRun(runtimePost, job, owner, errorCode, errorMessage, metadata) {
  await runtimePost(`/api/llm-tasks/${encodeURIComponent(job.runId)}/fail`, {
    taskId: job.taskId,
    runnerInstanceId: owner,
    attempt: job.attempt,
    errorCode,
    error: errorMessage,
    metadata,
  });
}

function normalizeAdapterConfig(config) {
  if (!config || typeof config !== "object") throw new WebQaAdapterError("webqa_config_invalid", "WebQA transport config is required");
  const gatewayBaseUrl = text(config.gatewayBaseUrl).replace(/\/+$/, "");
  const taskdBaseUrl = text(config.taskdBaseUrl).replace(/\/+$/, "");
  const provider = text(config.provider) || "chatgpt-web";
  const platform = text(config.platform) || "stock-info";
  if ((!gatewayBaseUrl && !taskdBaseUrl) || !provider || !platform) throw new WebQaAdapterError("webqa_config_invalid", "WebQA gatewayBaseUrl or taskdBaseUrl, provider and platform are required");
  return {
    ...config,
    ...(gatewayBaseUrl ? { gatewayBaseUrl } : {}),
    ...(taskdBaseUrl ? { taskdBaseUrl } : {}),
    taskdNamespace: text(config.taskdNamespace) || "stock-info",
    taskdTaskType: text(config.taskdTaskType) || DEFAULT_TASKD_TASK_TYPE,
    taskdTokenEnv: text(config.taskdTokenEnv) || "STOCK_INFO_TASKD_CALLER_TOKEN",
    provider,
    platform,
    pollIntervalMs: positiveInteger(config.pollIntervalMs, 1200),
    taskTimeoutMs: positiveInteger(config.taskTimeoutMs, 1200000),
    cancelGraceMs: positiveInteger(config.cancelGraceMs, 30000),
    heartbeatIntervalMs: positiveInteger(config.heartbeatIntervalMs, 10000),
    reasoningEffort: text(config.reasoningEffort) || null,
    attachments: Array.isArray(config.attachments) ? config.attachments : [],
    newSession: config.newSession === true,
    singleTabMode: config.singleTabMode === true,
  };
}

function readRawModelRequest(job) {
  const request = job?.request?.rawModelRequest || job?.rawModelRequest || job?.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new WebQaAdapterError("webqa_input_missing", "generic raw model request is missing");
  return request;
}

function genericTaskIdentity(job) {
  const task = job?.task || job;
  const identity = {
    taskType: text(task?.taskType) || "generic_raw_model",
    targetType: text(task?.targetType) || "llm_request",
    targetId: text(task?.targetId) || text(job?.taskId),
    idempotencyKey: text(task?.idempotencyKey) || text(job?.taskId),
    protocolVersion: text(task?.protocolVersion) || "llm-task-protocol.v1",
    promptVersion: text(task?.promptVersion) || "generic-raw-model.v1",
  };
  if (!identity.targetId || !identity.idempotencyKey) throw new WebQaAdapterError("webqa_identity_missing", "generic task identity is required for WebQA idempotency");
  return identity;
}

function renderGenericPrompt(request) {
  const pieces = [];
  // WebQA can submit only one ordinary text input, not a native system-role
  // message. Name this section for what it is instead of implying a privilege
  // boundary that does not exist in the browser-backed transport.
  if (text(request.instructions)) pieces.push(`任务要求：\n${text(request.instructions)}`);
  if (Array.isArray(request.input)) {
    for (const message of request.input) {
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const role = text(message.role) || "user";
      const content = Array.isArray(message.content)
        ? message.content.map((item) => text(item?.text)).filter(Boolean).join("\n")
        : text(message.content);
      if (content) pieces.push(`${role}:\n${content}`);
    }
  } else if (text(request.input)) {
    pieces.push(text(request.input));
  }
  if (text(request.userPrompt)) pieces.push(text(request.userPrompt));
  return pieces.join("\n\n").trim();
}

function readExternalProgress(job) {
  const progress = job?.run?.progress || job?.progress;
  if (progress && typeof progress === "object" && !Array.isArray(progress)) {
    const external = progress.external;
    if (external && typeof external === "object" && !Array.isArray(external) && external.kind === "webqa") return external;
  }
  const recoveryExternal = job?.recoveryExternal;
  if (recoveryExternal && typeof recoveryExternal === "object" && !Array.isArray(recoveryExternal) && recoveryExternal.kind === "webqa") return recoveryExternal;
  return null;
}

function restoreExternalRequest(external, config) {
  const conversationId = text(external.conversationId);
  const idempotencyKey = text(external.idempotencyKey);
  if (!conversationId || !idempotencyKey) throw new WebQaAdapterError("webqa_progress_invalid", "saved WebQA progress lacks conversation or idempotency identity");
  const reasoningEffort = text(external.reasoningEffort) || text(config.reasoningEffort);
  return {
    platform: text(external.platform) || config.platform,
    conversation_id: conversationId,
    provider: text(external.provider) || config.provider,
    input: "",
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    attachments: [],
    new_session: false,
    single_tab_mode: config.singleTabMode,
    timeout_ms: config.taskTimeoutMs,
    mode: text(external.mode) || "ask",
    idempotency_key: idempotencyKey,
    ...(text(external.recoveredFromRunId) ? { recoveredFromRunId: text(external.recoveredFromRunId) } : {}),
    ...(text(external.recoveredFromTaskId) ? { recoveredFromTaskId: text(external.recoveredFromTaskId) } : {}),
  };
}

function terminalMetadataFor(snapshot, request, taskId) {
  return {
    transport: "webqa",
    gatewayTaskId: taskId,
    ...(text(snapshot.taskdTaskId) ? { taskdTaskId: text(snapshot.taskdTaskId) } : {}),
    ...(text(snapshot.gatewayTaskId) ? { executorGatewayTaskId: text(snapshot.gatewayTaskId) } : {}),
    gatewayStatus: snapshot.status,
    provider: snapshot.provider || request.provider,
    platform: snapshot.platform || request.platform,
    requestConversationId: snapshot.requestConversationId || request.conversation_id,
    providerConversationId: snapshot.providerConversationId,
    providerUrl: snapshot.providerUrl,
    mode: snapshot.mode || request.mode,
    reasoningEffort: snapshot.reasoningEffort || request.reasoning_effort,
    cancelRequested: snapshot.cancelRequested,
    completionEvidence: snapshot.terminalEvidence,
    events: snapshot.events,
    updatedAt: snapshot.updatedAt,
    ...(text(request.recoveredFromRunId) ? { recoveredFromRunId: text(request.recoveredFromRunId) } : {}),
    ...(text(request.recoveredFromTaskId) ? { recoveredFromTaskId: text(request.recoveredFromTaskId) } : {}),
  };
}

function hasGeneratedOutput(raw) {
  return Array.isArray(raw?.generated_files) && raw.generated_files.length > 0
    || Array.isArray(raw?.generated_images) && raw.generated_images.length > 0;
}

function stableGatewayError(message, fallback) {
  const value = slug(message).slice(0, 80);
  return value ? `webqa_${value}` : fallback;
}

function mapTaskdStatus(taskdStatus, gatewayStatus) {
  const remote = text(taskdStatus);
  const gateway = text(gatewayStatus);
  if (remote === "succeeded") return "succeeded";
  if (remote === "failed") return "failed";
  if (remote === "cancelled") return "cancelled";
  if (remote === "cancel_requested") return "cancelling";
  if (gateway && WEBQA_STATUSES.has(gateway)) return gateway;
  if (remote === "running" || remote === "leased") return "streaming";
  if (remote === "queued") return "queued";
  return remote;
}

function isTransientGatewayUnavailable(error) {
  return error instanceof WebQaAdapterError && error.code === "webqa_gateway_unavailable";
}

function ensureLease(active) {
  if (!active) throw new WebQaAdapterError("webqa_lease_lost", "generic LLM run lease is no longer owned by this runner");
}

function asWebQaError(error, fallback) {
  if (error instanceof WebQaAdapterError) return error;
  return new WebQaAdapterError(fallback, error instanceof Error ? error.message : String(error), { cause: error });
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  return { status: text(event.status), at: text(event.at), message: text(event.message) };
}

function slug(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
}

function text(value) {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
