import { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { fail, ok } from "../../../shared/http";
import {
  claimNextGenericLlmQueueTaskRun,
  completeGenericLlmRun,
  createGenericLlmTask,
  failGenericLlmRun,
  heartbeatGenericLlmRun,
  loadGenericLlmRun,
  loadGenericLlmRunArtifacts,
  loadGenericLlmChildTasks,
  loadGenericWorkflowArtifacts,
  loadGenericLlmTask,
  normalizeGenericLlmPriority,
  recoverGenericWebQaFinalReport,
  recordGenericLlmRunProgress,
  requeueExpiredGenericLlmRun,
  writeGenericLlmRunArtifact,
  GENERIC_LLM_RAW_MODEL_ARTIFACT_STEP,
  GENERIC_LLM_RAW_MODEL_HANDLER_KEY,
  GENERIC_LLM_RAW_MODEL_TASK_TYPE,
  type GenericLlmTaskRunClaim,
} from "../../../shared/local-job-protocol";
import {
  prepareClaimedInformationProcessingJob,
  type InformationProcessingJob,
} from "../../knowledge/application/information-processing-jobs";

export const localLlmRoutes = new Hono<AppEnv>();

/** Enqueue one provider-neutral raw/model task.  The durable payload is the
 * only handoff to the local dispatcher; no request signal is persisted. */
localLlmRoutes.post("/llm-tasks", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") return fail(c, 404, "generic local LLM scheduler is only available in local LLM runtime");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const request = body.request && typeof body.request === "object" && !Array.isArray(body.request) ? body.request as Record<string, unknown> : null;
    if (!request || typeof request.model !== "string" || !request.model.trim()) return fail(c, 400, "request.model is required");
    if (!Array.isArray(request.input)) return fail(c, 400, "request.input is required");
    const originTaskType = typeof body.originTaskType === "string" ? body.originTaskType.trim() : "";
    const task = await createGenericLlmTask(c.env.DB, {
      taskType: GENERIC_LLM_RAW_MODEL_TASK_TYPE,
      targetType: typeof body.targetType === "string" && body.targetType.trim() ? body.targetType : "llm_request",
      targetId: typeof body.targetId === "string" && body.targetId.trim() ? body.targetId : `request:${crypto.randomUUID()}`,
      idempotencyKey: typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() ? body.idempotencyKey : `generic-raw:${crypto.randomUUID()}`,
      promptVersion: typeof body.promptVersion === "string" && body.promptVersion.trim() ? body.promptVersion : "generic-raw-model.v1",
      handlerKey: GENERIC_LLM_RAW_MODEL_HANDLER_KEY,
      model: request.model,
      reasoningEffort: typeof request.reasoningEffort === "string" ? request.reasoningEffort : null,
      priority: normalizeGenericLlmPriority(body.priority),
      metadata: { rawModelRequest: request, source: body.source ?? null, ...(originTaskType ? { originTaskType } : {}) },
    });
    return ok(c, task);
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

/** Reconnect/read bridge for direct adapters and CLI clients. */
localLlmRoutes.get("/llm-tasks/:taskId", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") return fail(c, 404, "generic local LLM scheduler is only available in local LLM runtime");
  const task = await loadGenericLlmTask(c.env.DB, c.req.param("taskId"));
  if (!task) return fail(c, 404, "generic LLM task not found");
  const run = task.lastRunId ? await loadGenericLlmRun(c.env.DB, task.lastRunId) : null;
  const artifacts = run ? await loadGenericLlmRunArtifacts(c.env.DB, run.runId) : [];
  const children = await loadGenericLlmChildTasks(c.env.DB, task.taskId);
  const workflowArtifacts = await loadGenericWorkflowArtifacts(c.env.DB, task.taskId);
  return ok(c, { task, run, artifacts, children, workflowArtifacts });
});

/**
 * Recover one persisted low-dependency final-report WebQA task in place. The
 * operation only requeues the existing generic task and carries its saved
 * gateway identity into the next run; the Node adapter performs GET-only
 * recovery and never submits another WebQA prompt.
 */
localLlmRoutes.post("/llm-tasks/:taskId/recover-webqa", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") return fail(c, 404, "generic WebQA recovery is only available in local LLM runtime");
  try {
    return ok(c, await recoverGenericWebQaFinalReport(c.env.DB, { taskId: c.req.param("taskId") }));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

/**
 * Universal local Node boundary. It owns claim ordering; handler-specific
 * routes remain completion adapters for the rollout and old run recovery.
 */
localLlmRoutes.post("/llm-tasks/claim-next", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") return fail(c, 404, "generic local LLM dispatcher is only available in local LLM runtime");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (typeof body.runnerInstanceId !== "string" || !body.runnerInstanceId.trim()) return fail(c, 400, "runnerInstanceId is required");
  let claim: GenericLlmTaskRunClaim | null = null;
  try {
    claim = await claimNextGenericLlmQueueTaskRun(c.env.DB, body.runnerInstanceId, {
      executionMode: body.executionMode === "model" || body.executionMode === "engineering" ? body.executionMode : undefined,
      excludeHandlerKeys: Array.isArray(body.excludeHandlerKeys)
        ? body.excludeHandlerKeys.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        : undefined,
    });
    if (!claim) return ok(c, null);
    const prepared = await prepareGenericTask(c.env, claim);
    return ok(c, { ...claim, ...prepared });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (claim) {
      await failGenericLlmRun(c.env.DB, {
        runId: claim.run.runId,
        taskId: claim.task.taskId,
        attempt: claim.run.attempt,
        leaseOwner: body.runnerInstanceId,
        errorCode: /unknown generic LLM handler/i.test(message) ? "unknown_handler" : "prepare_failed",
        errorMessage: message.slice(0, 1600),
      }).catch(() => {});
    }
    return fail(c, 400, message);
  }
});

localLlmRoutes.post("/llm-tasks/:runId/progress", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") return fail(c, 404, "generic local LLM dispatcher is only available in local LLM runtime");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (typeof body.taskId !== "string" || typeof body.runnerInstanceId !== "string" || !Number.isInteger(body.attempt)) return fail(c, 400, "taskId, runnerInstanceId and attempt are required");
  try {
    return ok(c, { active: await recordGenericLlmRunProgress(c.env.DB, {
      runId: c.req.param("runId"), taskId: body.taskId, attempt: body.attempt as number,
      leaseOwner: body.runnerInstanceId, stepKey: typeof body.stepKey === "string" ? body.stepKey : null,
      metadata: body.metadata ?? null,
    }) });
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

localLlmRoutes.post("/llm-tasks/:runId/partial", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") return fail(c, 404, "generic local LLM dispatcher is only available in local LLM runtime");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (typeof body.taskId !== "string" || typeof body.runnerInstanceId !== "string" || !Number.isInteger(body.attempt) || typeof body.text !== "string") return fail(c, 400, "taskId, runnerInstanceId, attempt and text are required");
  try {
    const artifact = await writeGenericLlmRunArtifact(c.env.DB, {
      runId: c.req.param("runId"), taskId: body.taskId, attempt: body.attempt as number,
      leaseOwner: body.runnerInstanceId, stepKey: typeof body.stepKey === "string" && body.stepKey.trim() ? body.stepKey : GENERIC_LLM_RAW_MODEL_ARTIFACT_STEP,
      outputType: "json", status: "partial", output: { text: body.text, delta: typeof body.delta === "string" ? body.delta : "", sequence: Number(body.sequence) || 0 },
      structureValid: null, terminalMetadata: { sequence: Number(body.sequence) || 0 },
    });
    await recordGenericLlmRunProgress(c.env.DB, {
      runId: c.req.param("runId"), taskId: body.taskId, attempt: body.attempt as number,
      leaseOwner: body.runnerInstanceId, stepKey: artifact.stepKey,
      metadata: { sequence: Number(body.sequence) || 0, textLength: body.text.length },
    });
    return ok(c, { artifact });
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

localLlmRoutes.post("/llm-tasks/:runId/artifact", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") return fail(c, 404, "generic local LLM dispatcher is only available in local LLM runtime");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (typeof body.taskId !== "string" || typeof body.runnerInstanceId !== "string" || !Number.isInteger(body.attempt)) return fail(c, 400, "taskId, runnerInstanceId and attempt are required");
  try {
    return ok(c, { artifact: await writeGenericLlmRunArtifact(c.env.DB, {
      runId: c.req.param("runId"), taskId: body.taskId, attempt: body.attempt as number,
      leaseOwner: body.runnerInstanceId, stepKey: typeof body.stepKey === "string" && body.stepKey.trim() ? body.stepKey : GENERIC_LLM_RAW_MODEL_ARTIFACT_STEP,
      outputType: body.outputType === "markdown" ? "markdown" : "json",
      status: body.status === "partial" ? "partial" : body.status === "failed" ? "failed" : "complete",
      output: body.output, structureValid: body.structureValid === null ? null : body.structureValid !== false,
      blocked: body.blocked, errorCode: typeof body.errorCode === "string" ? body.errorCode : null,
      errorMessage: typeof body.errorMessage === "string" ? body.errorMessage : null,
      terminalMetadata: body.terminalMetadata ?? null,
    }) });
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

localLlmRoutes.post("/llm-tasks/:runId/heartbeat", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") return fail(c, 404, "generic local LLM dispatcher is only available in local LLM runtime");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (typeof body.taskId !== "string" || typeof body.runnerInstanceId !== "string" || !Number.isInteger(body.attempt)) return fail(c, 400, "taskId, runnerInstanceId and attempt are required");
  try {
    return ok(c, { active: await heartbeatGenericLlmRun(c.env.DB, c.req.param("runId"), body.taskId, body.attempt as number, body.runnerInstanceId) });
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

/** Fenced generic failure used when a handler is unknown or cannot prepare. */
localLlmRoutes.post("/llm-tasks/:runId/fail", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") return fail(c, 404, "generic local LLM dispatcher is only available in local LLM runtime");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (typeof body.taskId !== "string" || typeof body.runnerInstanceId !== "string" || !Number.isInteger(body.attempt)) return fail(c, 400, "taskId, runnerInstanceId and attempt are required");
  try {
    return ok(c, await failGenericLlmRun(c.env.DB, {
      runId: c.req.param("runId"), taskId: body.taskId, attempt: body.attempt as number,
      leaseOwner: body.runnerInstanceId, errorCode: typeof body.errorCode === "string" ? body.errorCode : "provider_failed",
      errorMessage: typeof body.error === "string" ? body.error : "generic handler failed",
      terminalMetadata: body.metadata ?? null,
    }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

localLlmRoutes.post("/llm-tasks/:runId/requeue", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") return fail(c, 404, "generic local LLM dispatcher is only available in local LLM runtime");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (typeof body.taskId !== "string" || typeof body.runnerInstanceId !== "string" || !Number.isInteger(body.attempt)) return fail(c, 400, "taskId, runnerInstanceId and attempt are required");
  try {
    return ok(c, { requeued: await requeueExpiredGenericLlmRun(c.env.DB, {
      runId: c.req.param("runId"), taskId: body.taskId, attempt: body.attempt as number,
      leaseOwner: body.runnerInstanceId, errorMessage: typeof body.error === "string" ? body.error : undefined,
    }) });
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

/** Deterministic completion adapter for engineering-only handlers. */
localLlmRoutes.post("/llm-tasks/:runId/complete", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") return fail(c, 404, "generic local LLM dispatcher is only available in local LLM runtime");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (typeof body.taskId !== "string" || typeof body.runnerInstanceId !== "string" || !Number.isInteger(body.attempt)) return fail(c, 400, "taskId, runnerInstanceId and attempt are required");
  try {
    return ok(c, await completeGenericLlmRun(c.env.DB, {
      runId: c.req.param("runId"), taskId: body.taskId, attempt: body.attempt as number,
      leaseOwner: body.runnerInstanceId, status: body.status === "blocked" ? "blocked" : "completed",
      errorCode: typeof body.errorCode === "string" ? body.errorCode : null,
      errorMessage: typeof body.errorMessage === "string" ? body.errorMessage : null,
      terminalMetadata: body.metadata ?? null,
    }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

async function prepareGenericTask(env: AppEnv["Bindings"], claim: GenericLlmTaskRunClaim) {
  const handler = claim.task.handlerKey || claim.task.taskType;
  switch (handler) {
    case "information_processing": {
      const prepared = await prepareClaimedInformationProcessingJob(env, {
        taskId: claim.task.taskId, docId: claim.task.targetId, attempt: claim.run.attempt,
        leaseOwner: claim.run.leaseOwner || "", runId: claim.run.runId,
      } satisfies InformationProcessingJob);
      return { handlerKey: handler, request: prepared };
    }
    case "research_operating_analysis":
    case "research_operating_analysis_low_dependency":
    case "research_operating_analysis_low_dependency_coordinator":
    case "research_operating_analysis_low_dependency_stage":
      {
        const metadata = readTaskMetadata(claim.task.metadata);
      return {
        handlerKey: handler,
        request: {
          taskId: claim.task.taskId, runId: claim.run.runId, attempt: claim.run.attempt,
          runnerInstanceId: claim.run.leaseOwner, securityCode: claim.task.targetId,
          parentTaskId: claim.task.parentTaskId, stageKey: claim.task.stageKey,
          executionMode: claim.task.executionMode,
          forceStage: Boolean(metadata.rerun),
          model: claim.run.model, reasoningEffort: claim.run.reasoningEffort,
          promptVersion: claim.task.promptVersion, rerunStageKeys: readRerunStageKeys(claim.task.metadata),
          ...(typeof metadata.recoveryRawTaskId === "string" && metadata.recoveryRawTaskId.trim() ? { recoveryRawTaskId: metadata.recoveryRawTaskId.trim() } : {}),
          // Preserve the business task identity for any nested generic raw
          // request; the lower runner may use it for transport routing.
          originTaskType: claim.task.taskType,
        },
      };
      }
    case GENERIC_LLM_RAW_MODEL_HANDLER_KEY: {
      const metadata = claim.task.metadata && typeof claim.task.metadata === "object" && !Array.isArray(claim.task.metadata) ? claim.task.metadata as Record<string, unknown> : {};
      const rawModelRequest = metadata.rawModelRequest;
      if (!rawModelRequest || typeof rawModelRequest !== "object" || Array.isArray(rawModelRequest)) throw new Error("generic raw model request is missing");
      return {
        handlerKey: handler,
        request: {
          taskId: claim.task.taskId, runId: claim.run.runId, attempt: claim.run.attempt,
          runnerInstanceId: claim.run.leaseOwner, rawModelRequest,
          // The Node raw runner uses these provider-neutral identity fields to
          // select a lower transport and derive a stable external idempotency
          // tuple. Business stages do not select or name WebQA.
          handlerKey: handler,
          taskType: claim.task.taskType,
          targetType: claim.task.targetType,
          targetId: claim.task.targetId,
          idempotencyKey: claim.task.idempotencyKey,
          protocolVersion: claim.task.protocolVersion,
          promptVersion: claim.task.promptVersion,
          progress: claim.run.progress,
          ...(readOriginTaskType(metadata) ? { originTaskType: readOriginTaskType(metadata) } : {}),
          ...(metadata.recoveryExternal && typeof metadata.recoveryExternal === "object" && !Array.isArray(metadata.recoveryExternal)
            ? { recoveryExternal: metadata.recoveryExternal }
            : {}),
        },
      };
    }
    default:
      throw new Error(`unknown generic LLM handler: ${handler}`);
  }
}

function readRerunStageKeys(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const value = (metadata as Record<string, unknown>).rerunStageKeys;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readTaskMetadata(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, unknown> : {};
}

function readOriginTaskType(metadata: unknown): string {
  const value = readTaskMetadata(metadata).originTaskType;
  return typeof value === "string" ? value.trim() : "";
}
