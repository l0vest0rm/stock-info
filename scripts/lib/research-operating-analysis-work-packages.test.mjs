import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_ENVELOPE_VERSION,
  RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_VERSION,
  RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES,
  getResearchOperatingAnalysisWorkPackage,
  parseWorkPackageEnvelopeJson,
  projectWorkPackageStages,
  researchOperatingAnalysisWorkPackageWaves,
  workPackageForStage,
} from "./research-operating-analysis-work-packages.mjs";

function stageValue(stageKey, output = `# ${stageKey}`) {
  return { status: "complete", markdown: output, lineage: { upstreamArtifactIds: [], sourceIds: [], claimIds: [], evidenceIds: [], unknownIds: [] } };
}

function envelope(packageKey, overrides = {}) {
  const definition = getResearchOperatingAnalysisWorkPackage(packageKey);
  return {
    schemaVersion: RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_ENVELOPE_VERSION,
    packageKey,
    packageVersion: RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGE_VERSION,
    status: "complete",
    stages: Object.fromEntries(definition.stageKeys.map((stageKey) => [stageKey, stageValue(stageKey)])),
    packageLineage: { upstreamArtifactIds: [], sourceIds: [], claimIds: [], evidenceIds: [], unknownIds: [] },
    ...overrides,
  };
}

test("work packages have three generative requests plus deterministic boundaries", () => {
  assert.deepEqual(RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES.map((item) => item.key), [
    "foundation", "external_evidence", "quantitative_facts", "investment_synthesis", "deterministic_valuation", "report_assembly",
  ]);
  assert.deepEqual(researchOperatingAnalysisWorkPackageWaves().map((wave) => wave.map((item) => item.key)), [
    ["foundation"], ["external_evidence", "quantitative_facts"], ["investment_synthesis"], ["deterministic_valuation"], ["report_assembly"],
  ]);
  assert.equal(workPackageForStage("company_facts")?.key, "external_evidence");
  assert.equal(workPackageForStage("financial_quality")?.key, "quantitative_facts");
  assert.equal(workPackageForStage("investment_conclusion")?.key, "investment_synthesis");
  assert.equal(workPackageForStage("report_assembly")?.key, "report_assembly");
});

test("strict envelope parser requires every declared stage and projects legacy artifacts", () => {
  const parsed = parseWorkPackageEnvelopeJson(JSON.stringify(envelope("quantitative_facts")), "quantitative_facts");
  assert.deepEqual(Object.keys(parsed.stages), ["financial_quality", "market_valuation_facts"]);
  const projection = projectWorkPackageStages(parsed, "quantitative_facts");
  assert.equal(projection.financial_quality.output, "# financial_quality");
  assert.equal(projection.market_valuation_facts.status, "complete");
});

test("strict envelope parser rejects missing, unknown, and duplicate stages", () => {
  const complete = envelope("quantitative_facts");
  const missing = envelope("quantitative_facts", { stages: { financial_quality: stageValue("financial_quality") } });
  assert.throws(() => parseWorkPackageEnvelopeJson(JSON.stringify(missing), "quantitative_facts"), /missing stages.*market_valuation_facts/);

  const unknown = envelope("quantitative_facts", { stages: { ...complete.stages, unexpected: stageValue("unexpected") } });
  assert.throws(() => parseWorkPackageEnvelopeJson(JSON.stringify(unknown), "quantitative_facts"), /unknown stages.*unexpected/);

  const duplicate = JSON.stringify(complete).replace(
    '"market_valuation_facts":{"status":"complete"',
    '"financial_quality":{"status":"complete"',
  );
  // The replacement above is intentionally malformed as a semantic object;
  // use a small raw payload to exercise duplicate-key detection directly.
  const duplicateRaw = '{"schemaVersion":"research-operating-analysis.work-package-envelope.v1","packageKey":"quantitative_facts","packageVersion":"investment-analysis.work-packages.v1","status":"complete","stages":{"financial_quality":{"status":"complete","markdown":"x"},"financial_quality":{"status":"complete","markdown":"y"}}}';
  assert.equal(typeof duplicate, "string");
  assert.throws(() => parseWorkPackageEnvelopeJson(duplicateRaw, "quantitative_facts"), /duplicate JSON object key: financial_quality/);
});

test("partial stage cannot be projected as success", () => {
  const partial = envelope("quantitative_facts", {
    status: "partial",
    stages: {
      financial_quality: { ...stageValue("financial_quality"), status: "partial" },
      market_valuation_facts: stageValue("market_valuation_facts"),
    },
  });
  const parsed = parseWorkPackageEnvelopeJson(JSON.stringify(partial), "quantitative_facts");
  assert.equal(parsed.status, "partial");
  assert.equal(projectWorkPackageStages(parsed, "quantitative_facts").financial_quality.status, "partial");
  assert.notEqual(projectWorkPackageStages(parsed, "quantitative_facts").financial_quality.status, "complete");
  assert.throws(() => parseWorkPackageEnvelopeJson(JSON.stringify({ ...partial, status: "complete" }), "quantitative_facts"), /complete status requires every stage/);
});
