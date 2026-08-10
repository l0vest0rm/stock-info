import assert from "node:assert/strict";
import test from "node:test";
import {
  LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROTOCOL_VERSION,
  LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROMPT_VERSION,
  LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_TASK_TYPE,
  LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION,
  LOW_DEPENDENCY_DEFAULT_REASONING_EFFORT,
  WEBQA_EVIDENCE_MAX_ITEMS,
  effectiveLowDependencyRefreshStageKeys,
  evaluateLowDependencyResumeEligibility,
  lowDependencyResearchOperatingAnalysisTaskIdentity,
  normalizeFinalReportEvidence,
  normalizeLowDependencyRerunStageKeys,
} from "./research-operating-analysis-low-dependency.ts";

test("low-dependency model work packages default to WebQA xhigh reasoning", () => {
  assert.equal(LOW_DEPENDENCY_DEFAULT_REASONING_EFFORT, "xhigh");
});

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

test("WebQA evidence projection keeps only bounded HTTPS citation/source objects", () => {
  const citations = [
    { text: "valid", title: "Valid", url: "https://example.com/valid" },
    { text: "insecure", title: "HTTP", url: "http://example.com/nope" },
    { text: "relative", title: "Relative", url: "/relative" },
    { text: "missing url", title: "Missing" },
  ];
  const sources = [{ text: "source", title: "Source", url: "https://example.com/source" }];
  const evidence = normalizeFinalReportEvidence({ citations, sources, providerUrl: "http://provider.invalid" });
  assert.ok(evidence);
  assert.equal(evidence.citationCount, citations.length);
  assert.equal(evidence.sourceCount, sources.length);
  assert.deepEqual(evidence.citations, [{ text: "valid", title: "Valid", url: "https://example.com/valid" }]);
  assert.deepEqual(evidence.sources, sources);
  assert.equal(evidence.providerUrl, null);

  const many = Array.from({ length: WEBQA_EVIDENCE_MAX_ITEMS + 5 }, (_, index) => ({
    text: `citation-${index}`,
    title: `title-${index}`,
    url: `https://example.com/${index}`,
  }));
  const bounded = normalizeFinalReportEvidence({ citations: many, sources: many });
  assert.ok(bounded);
  assert.equal(bounded.citationCount, many.length);
  assert.equal(bounded.sourceCount, many.length);
  assert.equal(bounded.citations.length, WEBQA_EVIDENCE_MAX_ITEMS);
  assert.equal(bounded.sources.length, WEBQA_EVIDENCE_MAX_ITEMS);
  assert.deepEqual(Object.keys(bounded.citations[0]).sort(), ["text", "title", "url"]);
});

test("existing structured WebQA answer projects all 63 source records without raw payload", () => {
  const items = Array.from({ length: 63 }, (_, index) => ({ text: `source-${index}`, title: "", url: `https://example.com/source-${index}` }));
  const evidence = normalizeFinalReportEvidence({
    provider: "chatgpt-web",
    citationCount: items.length,
    sourceCount: items.length,
    citations: items,
    sources: items,
    raw: { shouldNotLeak: true },
  });
  assert.ok(evidence);
  assert.equal(evidence.citationCount, 63);
  assert.equal(evidence.sourceCount, 63);
  assert.equal(evidence.citations.length, 63);
  assert.equal(evidence.sources.length, 63);
  assert.equal("raw" in evidence, false);
});

test("resume is exposed only for the latest failed run with current reusable artifacts", () => {
  const current = {
    latestRunId: "llm-run:failed",
    latestRunStatus: "failed",
    latestRunPromptVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROMPT_VERSION,
    latestRunCodeVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION,
    stages: [
      { stageKey: "engineering_baseline", status: "complete", runStatus: "completed", promptVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROMPT_VERSION, codeVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION, stageVersion: "engineering-baseline.v1", projectionVersion: "research-artifact-projection.v1" },
      { stageKey: "company_facts", status: "failed", runStatus: "failed", promptVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROMPT_VERSION, codeVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION, stageVersion: "company-facts.v3", projectionVersion: "research-artifact-projection.v1" },
    ],
  };
  assert.equal(evaluateLowDependencyResumeEligibility(current).available, true);
  assert.deepEqual(evaluateLowDependencyResumeEligibility(current).failedStageKeys, ["company_facts"]);
  assert.deepEqual(evaluateLowDependencyResumeEligibility(current).reusableStageKeys, ["engineering_baseline"]);
  assert.equal(evaluateLowDependencyResumeEligibility({ ...current, latestRunStatus: "completed" }).available, false);
  assert.equal(evaluateLowDependencyResumeEligibility({ ...current, latestRunCodeVersion: "old-code" }).reason, "version_mismatch");
  assert.equal(evaluateLowDependencyResumeEligibility({ ...current, latestRunCodeVersion: null }).reason, "version_mismatch");
  assert.equal(evaluateLowDependencyResumeEligibility({ ...current, stages: [{ ...current.stages[0], codeVersion: null }, current.stages[1]] }).reason, "version_mismatch");
  assert.equal(evaluateLowDependencyResumeEligibility({ ...current, stages: [{ ...current.stages[1] }] }).reason, "no_reusable_stage_artifacts");
});
