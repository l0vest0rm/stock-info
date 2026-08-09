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
import { OPERATING_ANALYSIS_PROMPT_VERSION, OPERATING_ANALYSIS_REQUIRED_HEADINGS, OPERATING_ANALYSIS_STAGES, checkpointResearchOperatingAnalysisStage, completeResearchOperatingAnalysisJob, completeResearchOperatingAnalysisStage, requeueInterruptedResearchOperatingAnalysisJob, startResearchOperatingAnalysisStage } from "./research-operating-analysis.ts";

test("six prompts, six stage contracts, and the staged version stay aligned", () => {
  assert.equal(config.version, OPERATING_ANALYSIS_PROMPT_VERSION);
  assert.equal(OPERATING_ANALYSIS_STAGES.length, 6);
  assert.deepEqual(OPERATING_ANALYSIS_STAGES.map((item) => item.output), ["json", "json", "markdown", "markdown", "json", "markdown"]);
  for (const prompt of [RESEARCH_OPERATING_ANALYSIS_COMPANY_BASELINE_PROMPT, RESEARCH_OPERATING_ANALYSIS_INDUSTRY_VALIDATION_PROMPT, RESEARCH_OPERATING_ANALYSIS_OPERATING_STAGE_PROMPT, RESEARCH_OPERATING_ANALYSIS_FINANCIAL_STAGE_PROMPT, RESEARCH_OPERATING_ANALYSIS_VALUATION_INPUTS_PROMPT, RESEARCH_OPERATING_ANALYSIS_VALUATION_CONCLUSION_PROMPT]) assert.match(prompt, /<input_data>[\s\S]*\{\{INPUT_DATA\}\}/);
  assert.match(RESEARCH_OPERATING_ANALYSIS_COMPANY_BASELINE_PROMPT, /正式披露/);
  assert.match(RESEARCH_OPERATING_ANALYSIS_INDUSTRY_VALIDATION_PROMPT, /独立外部验证/);
  assert.match(RESEARCH_OPERATING_ANALYSIS_VALUATION_INPUTS_PROMPT, /不得输出目标价/);
  assert.match(RESEARCH_OPERATING_ANALYSIS_VALUATION_CONCLUSION_PROMPT, /deterministicValuation/);
});

test("a stage start stores its actual input and prompt separately from the stream", async () => {
  const statements = [];
  const db = { prepare(sql) { statements.push(sql); return { bind() {
    if (/select job_id as jobId from research_operating_analysis_jobs/.test(sql)) return { first: async () => ({ jobId: "operating-job" }) };
    if (/select status from research_operating_analysis_stage_artifacts/.test(sql)) return { first: async () => null };
    return { run: async () => ({ meta: { changes: 1 } }) };
  } }; } };
  await startResearchOperatingAnalysisStage(db, "300308.SZ", "company_baseline", { researchTaskId: "task" }, { model: "gpt-5.6-luna", instructions: "system", userPrompt: "user" }, "runner", 2);
  assert(statements.some((sql) => /insert into research_operating_analysis_stage_artifacts/.test(sql)));
  assert(statements.some((sql) => /update research_operating_analysis_jobs set prompt_json/.test(sql)));
});

test("terminal Markdown stage output is persisted independently", async () => {
  let update = "";
  const db = { prepare(sql) { return { bind() { return { run: async () => { update = sql; return { meta: { changes: 1 } }; } }; } }; } };
  await completeResearchOperatingAnalysisStage(db, "300308.SZ", "operating_analysis", "# 2. 公司概况与商业模式", "partial", "runner", 2);
  assert.match(update, /output_markdown/);
  await assert.rejects(() => completeResearchOperatingAnalysisStage(db, "300308.SZ", "company_baseline", "not JSON", "complete", "runner", 2), /JSON stage output is invalid/);
});

test("only an expired attempt can requeue its own running job", async () => {
  const statements = [];
  const db = { prepare(sql) { statements.push(sql); return { bind() {
    if (/select job_id as jobId, status, lease_owner/.test(sql)) return { first: async () => ({ jobId: "operating-job", status: "running", leaseOwner: "runner", leaseUntil: 0, attempt: 2 }) };
    return { run: async () => ({ meta: { changes: 1 } }) };
  } }; } };
  assert.equal(await requeueInterruptedResearchOperatingAnalysisJob(db, "300308.SZ", "connection lost", "runner", 2), true);
  assert(statements.some((sql) => /stage_artifacts set status='queued'/.test(sql)));
  assert(statements.some((sql) => /jobs set status='queued'.*lease_owner=null/.test(sql)));
});

test("a stale operating stage checkpoint is fenced by its attempt and owner", async () => {
  const db = { prepare() { return { bind() { return { run: async () => ({ meta: { changes: 0 } }) }; } }; } };
  await assert.rejects(() => checkpointResearchOperatingAnalysisStage(db, "300308.SZ", "operating_analysis", "late output", "runner-a", 1), /no longer running/);
});

test("final assembly cannot mark a run complete without all fixed chapters", async () => {
  await assert.rejects(() => completeResearchOperatingAnalysisJob({ prepare() { throw new Error("database must not be touched"); } }, "300308.SZ", {}, { instructions: "system", userPrompt: "user" }, "# 1. 研究范围", "", "fingerprint", "runner"), /operating analysis report is incomplete/);
  assert.equal(OPERATING_ANALYSIS_REQUIRED_HEADINGS.length, 11);
});
