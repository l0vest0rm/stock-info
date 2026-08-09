import assert from "node:assert/strict";
import test from "node:test";
import config from "../../../../config/research-operating-analysis.json" with { type: "json" };
import {
  RESEARCH_OPERATING_ANALYSIS_COMPANY_BASELINE_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_FINANCIAL_STAGE_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_INDUSTRY_VALIDATION_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_OPERATING_STAGE_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_VALUATION_CONCLUSION_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_VALUATION_INPUTS_PROMPT,
} from "../../../generated/prompt-text.ts";
import {
  OPERATING_ANALYSIS_PROMPT_VERSION,
  OPERATING_ANALYSIS_REQUIRED_HEADINGS,
  OPERATING_ANALYSIS_STAGES,
  completeResearchOperatingAnalysisStage,
  requeueInterruptedResearchOperatingAnalysisJob,
  startResearchOperatingAnalysisStage,
} from "./research-operating-analysis.ts";

function genericDb({ runStatus = "running", leaseUntil = Date.now() + 60_000, artifacts = [] } = {}) {
  const statements = [];
  const task = { taskId: "llm-task:operating", taskType: "research_operating_analysis", targetType: "security", targetId: "300308.SZ", idempotencyKey: "research-operating-analysis:300308.SZ", protocolVersion: "llm-task-protocol.v1", promptVersion: OPERATING_ANALYSIS_PROMPT_VERSION, status: "running", requestedModel: "gpt-5.6-luna", requestedReasoningEffort: "max", lastRunId: "llm-run:1", metadataJson: null, lastErrorCode: null, lastErrorMessage: null, createdAt: 1, startedAt: 1, completedAt: null, updatedAt: 1 };
  const run = { runId: "llm-run:1", taskId: task.taskId, attempt: 2, provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max", promptVersion: OPERATING_ANALYSIS_PROMPT_VERSION, inputFingerprint: null, inputAsOf: null, inputJson: null, promptJson: null, status: runStatus, leaseOwner: "runner", leaseUntil, heartbeatAt: Date.now(), currentStepKey: null, progressJson: null, progressUpdatedAt: null, terminalMetadataJson: null, errorCode: null, errorMessage: null, startedAt: 1, completedAt: null, updatedAt: 1 };
  const db = { statements, prepare(sql) { statements.push(sql); return { bind(...values) { return {
    first: async () => /from llm_tasks/.test(sql) ? task : /from llm_run_artifacts/.test(sql) ? { artifactId: "llm-artifact:1", runId: run.runId, stepKey: "operating_analysis", upstreamArtifactIdsJson: "[]", outputType: "markdown", status: "partial", outputJson: null, outputMarkdown: "# 2. 公司概况与商业模式", structureValid: 0, blockedJson: null, errorCode: null, errorMessage: null, terminalMetadataJson: "{}", completedAt: Date.now() } : /from llm_runs/.test(sql) ? run : /select run_id as runId from llm_runs/.test(sql) ? { runId: run.runId } : null,
    all: async () => ({ results: artifacts }),
    run: async () => ({ meta: { changes: 1 } }),
  }; } }; } };
  return db;
}

function terminalProjectionDb() {
  const statements = [];
  let taskStatus = "running";
  let runStatus = "running";
  const task = { taskId: "llm-task:operating", taskType: "research_operating_analysis", targetType: "security", targetId: "300308.SZ", idempotencyKey: "research-operating-analysis:300308.SZ", protocolVersion: "llm-task-protocol.v1", promptVersion: OPERATING_ANALYSIS_PROMPT_VERSION, requestedModel: "gpt-5.6-luna", requestedReasoningEffort: "max", lastRunId: "llm-run:1", metadataJson: null, lastErrorCode: null, lastErrorMessage: null, createdAt: 1, startedAt: 1, completedAt: null, updatedAt: 1 };
  const run = { runId: "llm-run:1", taskId: task.taskId, attempt: 2, provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "max", promptVersion: OPERATING_ANALYSIS_PROMPT_VERSION, inputFingerprint: "fingerprint", inputAsOf: 1, inputJson: null, promptJson: null, status: runStatus, leaseOwner: "runner", leaseUntil: Date.now() + 60_000, heartbeatAt: Date.now(), currentStepKey: "valuation_conclusion", progressJson: null, progressUpdatedAt: null, terminalMetadataJson: null, errorCode: null, errorMessage: null, startedAt: 1, completedAt: null, updatedAt: 1 };
  const db = { statements, prepare(sql) { statements.push(sql); return { bind(...values) { return {
    first: async () => /from llm_tasks/.test(sql) ? { ...task, status: taskStatus } : /from llm_run_artifacts/.test(sql) ? null : /from llm_runs/.test(sql) ? { ...run, status: runStatus, leaseUntil: runStatus === "running" ? Date.now() + 60_000 : null } : /from local_job_provider_leases/.test(sql) ? { jobId: task.taskId } : /from research_operating_analysis_runs/.test(sql) ? { runId: run.runId, securityCode: "300308.SZ", promptVersion: OPERATING_ANALYSIS_PROMPT_VERSION, inputFingerprint: "fingerprint", inputAsOf: 1, inputJson: "{}", reportMarkdown: OPERATING_ANALYSIS_REQUIRED_HEADINGS.join("\n"), reasoningMarkdown: "", totalDurationMs: 10, streamStatsJson: "{}", promptJson: JSON.stringify({ instructions: "system", userPrompt: "user" }), provider: "openai", generatedAt: 2 } : null,
    all: async () => ({ results: [] }),
    run: async () => { if (/update llm_runs set status=/.test(sql)) runStatus = "completed"; if (/update llm_tasks set status=/.test(sql)) taskStatus = "completed"; return { meta: { changes: 1 } }; },
  }; } }; } };
  return db;
}

test("six prompts, six stage contracts, and the staged version stay aligned", () => {
  assert.equal(config.version, OPERATING_ANALYSIS_PROMPT_VERSION);
  assert.equal("streamCheckpoint" in config, false);
  assert.equal(OPERATING_ANALYSIS_STAGES.length, 6);
  assert.deepEqual(OPERATING_ANALYSIS_STAGES.map((item) => item.output), ["json", "json", "markdown", "markdown", "json", "markdown"]);
  for (const prompt of [RESEARCH_OPERATING_ANALYSIS_COMPANY_BASELINE_PROMPT, RESEARCH_OPERATING_ANALYSIS_INDUSTRY_VALIDATION_PROMPT, RESEARCH_OPERATING_ANALYSIS_OPERATING_STAGE_PROMPT, RESEARCH_OPERATING_ANALYSIS_FINANCIAL_STAGE_PROMPT, RESEARCH_OPERATING_ANALYSIS_VALUATION_INPUTS_PROMPT, RESEARCH_OPERATING_ANALYSIS_VALUATION_CONCLUSION_PROMPT]) assert.match(prompt, /<input_data>[\s\S]*\{\{INPUT_DATA\}\}/);
  assert.match(RESEARCH_OPERATING_ANALYSIS_COMPANY_BASELINE_PROMPT, /正式披露/);
  assert.match(RESEARCH_OPERATING_ANALYSIS_INDUSTRY_VALIDATION_PROMPT, /独立外部验证/);
  assert.match(RESEARCH_OPERATING_ANALYSIS_VALUATION_INPUTS_PROMPT, /不得输出目标价/);
  assert.match(RESEARCH_OPERATING_ANALYSIS_VALUATION_CONCLUSION_PROMPT, /deterministicValuation/);
});

test("stage start records structured generic progress, never a body checkpoint", async () => {
  const db = genericDb();
  await startResearchOperatingAnalysisStage(db, "300308.SZ", "company_baseline", { researchTaskId: "task" }, { model: "gpt-5.6-luna", instructions: "system", userPrompt: "user" }, "runner", 2);
  assert(db.statements.some((sql) => /update llm_runs set current_step_key/.test(sql)));
  assert(!db.statements.some((sql) => /partial_output|research_operating_analysis_stage_artifacts/.test(sql)));
});

test("terminal stage output uses the generic artifact table and validates JSON shape", async () => {
  const db = genericDb();
  await completeResearchOperatingAnalysisStage(db, "300308.SZ", "operating_analysis", "# 2. 公司概况与商业模式", "partial", "runner", 2);
  assert(db.statements.some((sql) => /insert into llm_run_artifacts/.test(sql)));
  await assert.rejects(() => completeResearchOperatingAnalysisStage(db, "300308.SZ", "company_baseline", "not JSON", "complete", "runner", 2), /JSON stage output is invalid/);
});

test("a stale generic run lease cannot start or persist a stage", async () => {
  const db = genericDb({ leaseUntil: 0 });
  await assert.rejects(() => startResearchOperatingAnalysisStage(db, "300308.SZ", "company_baseline", { researchTaskId: "task" }, { model: "gpt-5.6-luna", instructions: "system", userPrompt: "user" }, "runner", 2), /lease is no longer owned/);
  assert(!db.statements.some((sql) => /update llm_runs set current_step_key|insert into llm_run_artifacts/.test(sql)));
});

test("transport recovery requeues only the identified generic run", async () => {
  const db = genericDb({ leaseUntil: 0 });
  assert.equal(await requeueInterruptedResearchOperatingAnalysisJob(db, "300308.SZ", "connection lost", "runner", 2), true);
  assert(db.statements.some((sql) => /update llm_runs set status='failed'[\s\S]*where run_id=\? and task_id=\?/.test(sql)));
  assert(!db.statements.some((sql) => /from llm_runs where status='running' and lease_until/.test(sql)));
});

test("report completion projects the generic run id and terminalizes the generic run", async () => {
  const db = terminalProjectionDb();
  const { completeResearchOperatingAnalysisJob } = await import("./research-operating-analysis.ts");
  await completeResearchOperatingAnalysisJob(db, "300308.SZ", { security: { securityCode: "300308.SZ" } }, { instructions: "system", userPrompt: "user" }, OPERATING_ANALYSIS_REQUIRED_HEADINGS.join("\n"), "", "fingerprint", "runner", 2, { staged: true });
  assert(db.statements.some((sql) => /insert or ignore into research_operating_analysis_runs/.test(sql)));
  assert(db.statements.some((sql) => /update llm_runs set status=/.test(sql)));
  assert(db.statements.some((sql) => /where run_id=\? and task_id=\?/.test(sql)));
});

test("final assembly still rejects incomplete reports before touching the database", async () => {
  const { completeResearchOperatingAnalysisJob } = await import("./research-operating-analysis.ts");
  await assert.rejects(() => completeResearchOperatingAnalysisJob({ prepare() { throw new Error("database must not be touched"); } }, "300308.SZ", {}, { instructions: "system", userPrompt: "user" }, "# 1. 研究范围", "", "fingerprint", "runner", 2), /operating analysis report is incomplete/);
  assert.equal(OPERATING_ANALYSIS_REQUIRED_HEADINGS.length, 11);
});
