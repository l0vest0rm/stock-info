import assert from "node:assert/strict";
import test from "node:test";
import {
  LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROTOCOL_VERSION,
  LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROMPT_VERSION,
  LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_TASK_TYPE,
  effectiveLowDependencyRefreshStageKeys,
  lowDependencyResearchOperatingAnalysisTaskIdentity,
  normalizeLowDependencyRerunStageKeys,
} from "./research-operating-analysis-low-dependency.ts";

test("low-dependency application task identity remains isolated from the staged task", () => {
  const identity = lowDependencyResearchOperatingAnalysisTaskIdentity("300308.SZ");
  assert.equal(identity.taskType, LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_TASK_TYPE);
  assert.equal(identity.protocolVersion, LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROTOCOL_VERSION);
  assert.equal(identity.promptVersion, LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROMPT_VERSION);
  assert.notEqual(identity.taskType, "research_operating_analysis");
  assert.notEqual(identity.promptVersion, "investment-analysis.staged.v1");
});

test("targeted rerun keys reject unknown or duplicate stages and remain deterministic", () => {
  assert.deepEqual(normalizeLowDependencyRerunStageKeys(["financial_quality", "company_facts"]), ["company_facts", "financial_quality"]);
  assert.deepEqual(normalizeLowDependencyRerunStageKeys(undefined), []);
  assert.throws(() => normalizeLowDependencyRerunStageKeys(["company_baseline"]), /unsupported low-dependency/);
  assert.throws(() => normalizeLowDependencyRerunStageKeys(["company_facts", "company_facts"]), /duplicate stage/);
});

test("force refresh invalidates the complete S0-S12 target set before a new run", () => {
  const keys = effectiveLowDependencyRefreshStageKeys(true, ["engineering_baseline"]);
  assert.equal(keys[0], "engineering_baseline");
  assert.equal(keys[1], "local_routing_match");
  assert.equal(keys.at(-1), "report_assembly");
  assert.equal(keys.length, 14);
  assert.deepEqual(effectiveLowDependencyRefreshStageKeys(false, ["local_routing_match"]), ["local_routing_match"]);
});
