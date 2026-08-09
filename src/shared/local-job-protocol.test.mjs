import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { genericArtifactCompatibilityMatches, normalizeGenericLlmIdArray } from "./local-job-protocol.ts";

test("generic artifact lineage IDs default safely when omitted", () => {
  assert.deepEqual(normalizeGenericLlmIdArray(undefined, "sourceIds"), []);
  assert.deepEqual(normalizeGenericLlmIdArray(["source:b", "source:a"], "sourceIds"), ["source:b", "source:a"]);
});

test("generic artifact lineage IDs reject empty, positional and duplicate values", () => {
  assert.throws(() => normalizeGenericLlmIdArray([""], "sourceIds"), /invalid ID/);
  assert.throws(() => normalizeGenericLlmIdArray(["3"], "sourceIds"), /invalid ID/);
  assert.throws(() => normalizeGenericLlmIdArray(["source:a", "source:a"], "sourceIds"), /duplicate ID/);
  assert.throws(() => normalizeGenericLlmIdArray(["source a"], "sourceIds"), /invalid ID/);
});

test("recovery reuses only exact compatible terminal artifacts", () => {
  const expected = { stageVersion: "company-facts.v1", inputFingerprint: "fp:new", upstreamArtifactIds: ["llm-artifact:s0"], projectionVersion: "research-artifact-projection.v1" };
  const complete = { status: "complete", ...expected };
  assert.equal(genericArtifactCompatibilityMatches(complete, expected), true);
  assert.equal(genericArtifactCompatibilityMatches({ ...complete, status: "failed" }, expected), false);
  assert.equal(genericArtifactCompatibilityMatches({ ...complete, inputFingerprint: "fp:changed" }, expected), false);
  assert.equal(genericArtifactCompatibilityMatches({ ...complete, upstreamArtifactIds: ["llm-artifact:other"] }, expected), false);
  assert.equal(genericArtifactCompatibilityMatches({ ...complete, projectionVersion: "legacy" }, expected), false);
  assert.equal(genericArtifactCompatibilityMatches({ ...complete, status: "not_applicable" }, expected), true);
});

test("artifact recovery migration preserves stable IDs through run links", async () => {
  const migration = await readFile(new URL("../../migrations/0108_research_operating_analysis_artifact_contract.sql", import.meta.url), "utf8");
  assert.match(migration, /alter table llm_runs add column lineage_run_id/);
  assert.match(migration, /create table if not exists llm_run_artifact_links/);
  assert.match(migration, /primary key \(run_id, step_key\)/);
  assert.match(migration, /foreign key \(artifact_id\) references llm_run_artifacts/);
});
