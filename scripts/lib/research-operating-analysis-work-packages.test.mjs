import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_ENVELOPE_VERSION,
  RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_VERSION,
  RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES,
  getResearchOperatingAnalysisWorkPackage,
  normalizeFinalReportMarkdown,
  parseWorkPackageEnvelopeJson,
  projectWorkPackageStages,
  researchOperatingAnalysisGenerativeWorkPackages,
  researchOperatingAnalysisWorkPackageWaves,
  workPackageForStage,
} from "./research-operating-analysis-work-packages.mjs";

const lineage = () => ({ upstreamArtifactIds: [], sourceIds: [], claimIds: [], evidenceIds: [], unknownIds: [] });
const stageValue = (stageKey) => ({ status: "complete", output: { stageKey }, lineage: lineage() });
function foundation(overrides = {}) {
  return {
    schemaVersion: RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_ENVELOPE_VERSION,
    packageKey: "foundation",
    packageVersion: RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_VERSION,
    status: "complete",
    stages: {
      engineering_baseline: stageValue("engineering_baseline"),
      local_routing_match: stageValue("local_routing_match"),
    },
    packageLineage: lineage(),
    ...overrides,
  };
}

// Registry v3 consolidated the three former generative packages into a final
// Markdown report. The envelope parser still owns deterministic stage output.
test("registry gives final_report the generative stages and keeps deterministic valuation bypassed", () => {
  assert.deepEqual(RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES.map((item) => item.key), [
    "foundation", "final_report", "deterministic_valuation",
  ]);
  assert.deepEqual(researchOperatingAnalysisWorkPackageWaves().map((wave) => wave.map((item) => item.key)), [
    ["foundation", "deterministic_valuation"], ["final_report"],
  ]);
  assert.deepEqual(researchOperatingAnalysisGenerativeWorkPackages().map((item) => item.key), ["final_report"]);
  for (const key of ["company_facts", "financial_quality", "investment_conclusion", "report_assembly"]) {
    assert.equal(workPackageForStage(key)?.key, "final_report");
  }
  assert.equal(workPackageForStage("engineering_baseline")?.key, "foundation");
  assert.equal(getResearchOperatingAnalysisWorkPackage("deterministic_valuation").bypassed, true);
  assert.throws(() => getResearchOperatingAnalysisWorkPackage("quantitative_facts"), /unsupported/);
});

test("final report accepts nonempty human-readable Markdown without a machine envelope", () => {
  assert.equal(normalizeFinalReportMarkdown("  # 投资分析\n\n报告正文  ", "final_report"), "# 投资分析\n\n报告正文");
  assert.throws(() => normalizeFinalReportMarkdown(" ", "final_report"), /empty/);
  assert.throws(() => normalizeFinalReportMarkdown("# report", "foundation"), /not a final-report/);
});

test("strict envelope parser requires declared foundation stages and projects their objects", () => {
  const parsed = parseWorkPackageEnvelopeJson(JSON.stringify(foundation()), "foundation");
  assert.deepEqual(Object.keys(parsed.stages), ["engineering_baseline", "local_routing_match"]);
  const projection = projectWorkPackageStages(parsed, "foundation");
  assert.deepEqual(projection.engineering_baseline.output, { stageKey: "engineering_baseline" });
  assert.equal(projection.local_routing_match.status, "complete");
  const invalid = foundation();
  invalid.stages.engineering_baseline = { status: "complete", markdown: "wrong output type" };
  assert.throws(() => parseWorkPackageEnvelopeJson(JSON.stringify(invalid), "foundation"), /must provide object output/);
});

test("strict envelope parser rejects missing, unknown, and duplicate stages", () => {
  const complete = foundation();
  const missing = foundation({ stages: { engineering_baseline: stageValue("engineering_baseline") } });
  assert.throws(() => parseWorkPackageEnvelopeJson(JSON.stringify(missing), "foundation"), /missing stages.*local_routing_match/);
  const unknown = foundation({ stages: { ...complete.stages, unexpected: stageValue("unexpected") } });
  assert.throws(() => parseWorkPackageEnvelopeJson(JSON.stringify(unknown), "foundation"), /unknown stages.*unexpected/);
  const duplicateRaw = JSON.stringify(complete).replace('"local_routing_match":{', '"engineering_baseline":{');
  assert.throws(() => parseWorkPackageEnvelopeJson(duplicateRaw, "foundation"), /duplicate JSON object key: engineering_baseline/);
});

test("partial stage cannot be projected as success", () => {
  const partial = foundation();
  partial.status = "partial";
  partial.stages.engineering_baseline.status = "partial";
  const parsed = parseWorkPackageEnvelopeJson(JSON.stringify(partial), "foundation");
  assert.equal(parsed.status, "partial");
  const projection = projectWorkPackageStages(parsed, "foundation");
  assert.equal(projection.engineering_baseline.status, "partial");
  assert.equal(projection.local_routing_match.status, "complete");
  assert.throws(() => parseWorkPackageEnvelopeJson(JSON.stringify({ ...partial, status: "complete" }), "foundation"), /complete status requires every stage/);
});
