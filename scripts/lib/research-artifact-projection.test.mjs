import assert from "node:assert/strict";
import test from "node:test";
import {
  projectResearchArtifact,
  projectResearchArtifacts,
  validateResearchArtifactManifest,
} from "./research-artifact-projection.mjs";

test("artifact projection keeps declared fields and immutable lineage only", () => {
  const projection = projectResearchArtifact({
    stageKey: "operating_thesis",
    artifact: {
      artifactId: "llm-artifact:thesis-1",
      runId: "llm-run:1",
      stepKey: "operating_thesis",
      stageVersion: "operating-thesis.v1",
      inputFingerprint: "sha256:input",
      upstreamArtifactIds: ["llm-artifact:company-facts"],
      sourceIds: ["source:filing-1"],
      claimIds: ["claim:revenue-driver"],
      evidenceIds: ["evidence:filing-1"],
      unknownIds: ["unknown:peer-margin"],
      status: "complete",
      output: {
        summary: "需求到收入的可证伪链",
        thesis: [{ id: "judgment:thesis-1" }],
        claims: [{ id: "claim:revenue-driver" }],
      },
    },
    analysisGaps: [{ gapId: "analysis-gap:one", code: "missing_peer", blocking: false }],
  });
  assert.equal(projection.schemaVersion, "research-artifact-projection.v1");
  assert.deepEqual(projection.sourceArtifactIds, ["llm-artifact:thesis-1"]);
  assert.deepEqual(projection.upstreamArtifactIds, ["llm-artifact:company-facts"]);
  assert.deepEqual(Object.keys(projection.fields).sort(), ["claims", "summary", "thesis"]);
  assert.equal("outputMarkdown" in projection, false);
});

test("projection rejects undeclared fields, duplicate IDs and positional IDs", () => {
  assert.throws(() => projectResearchArtifact({
    stageKey: "company_facts",
    artifact: {
      artifactId: "llm-artifact:1",
      stepKey: "company_facts",
      status: "complete",
      sourceIds: ["source:a", "source:a"],
      output: { summary: "ok", hiddenModelInstruction: "must not leak" },
    },
  }), /duplicate ID/);
  assert.throws(() => projectResearchArtifact({
    stageKey: "company_facts",
    artifact: {
      artifactId: "llm-artifact:2",
      stepKey: "company_facts",
      status: "complete",
      output: { summary: "ok", hiddenModelInstruction: "must not leak" },
    },
  }), /undeclared fields/);
  assert.throws(() => projectResearchArtifact({
    stageKey: "company_facts",
    artifact: {
      artifactId: "llm-artifact:3",
      stepKey: "company_facts",
      status: "complete",
      upstreamArtifactIds: ["0"],
      output: { summary: "ok" },
    },
  }), /invalid|positional/);
});

test("P3-P4 JSON envelopes retain only their declared markdown body and manifest fields", () => {
  const projection = projectResearchArtifact({
    stageKey: "company_facts",
    artifact: {
      artifactId: "llm-artifact:company-facts-1",
      stepKey: "company_facts",
      status: "complete",
      output: { markdown: "# 公司事实", companyScope: { products: ["产品"] }, sourceIds: ["source:filing"], claimIds: ["claim:scope"], evidenceIds: ["evidence:scope"], usedUpstreamArtifactIds: ["llm-artifact:s0"] },
    },
  });
  assert.equal(projection.fields.markdown, "# 公司事实");
  assert.deepEqual(projection.fields.companyScope.products, ["产品"]);
  assert.throws(() => projectResearchArtifact({
    stageKey: "company_facts",
    artifact: { artifactId: "llm-artifact:company-facts-2", stepKey: "company_facts", status: "complete", output: { markdown: "ok", hiddenFullText: "not declared" } },
  }), /undeclared fields/);
});

test("manifest validates a complete named source-to-report graph", () => {
  const manifest = validateResearchArtifactManifest({
    schemaVersion: "research-evidence-manifest.v1",
    nodes: {
      sources: [{ id: "source:filing-1" }],
      evidence: [{ id: "evidence:filing-1", sourceIds: ["source:filing-1"] }],
      claims: [{ id: "claim:growth", evidenceIds: ["evidence:filing-1"] }],
      judgments: [{ id: "judgment:thesis", claimIds: ["claim:growth"] }],
      assumptions: [{ id: "assumption:base", judgmentIds: ["judgment:thesis"] }],
      risks: [],
      calculations: [{ id: "calculation:base", assumptionIds: ["assumption:base"], riskIds: [] }],
      reports: [{ id: "report:main", calculationIds: ["calculation:base"] }],
    },
  });
  assert.deepEqual(manifest.nodes.reports[0].calculationIds, ["calculation:base"]);
  assert.deepEqual(manifest.nodes.calculations[0].assumptionIds, ["assumption:base"]);
});

test("manifest rejects unknown references and array-position identities", () => {
  assert.throws(() => validateResearchArtifactManifest({
    schemaVersion: "research-evidence-manifest.v1",
    nodes: {
      sources: [{ id: "source:filing-1" }],
      evidence: [{ id: "evidence:filing-1", sourceIds: ["source:missing"] }],
      claims: [],
      judgments: [],
      assumptions: [],
      risks: [],
      calculations: [],
      reports: [],
    },
  }, { allowPartial: true }), /unknown source ID/);
  assert.throws(() => validateResearchArtifactManifest({
    schemaVersion: "research-evidence-manifest.v1",
    nodes: {
      sources: [{ id: "0" }],
      evidence: [], claims: [], judgments: [], assumptions: [], risks: [], calculations: [], reports: [],
    },
  }, { allowPartial: true }), /invalid or positional/);
});

test("multi-artifact projection rejects duplicate field ownership", () => {
  const artifact = (artifactId, summary) => ({ artifactId, stepKey: "company_facts", status: "complete", output: { summary } });
  assert.throws(() => projectResearchArtifacts({
    stageKey: "company_facts",
    artifacts: [artifact("llm-artifact:a", "one"), artifact("llm-artifact:b", "two")],
  }), /duplicate field owner/);
});
