import assert from "node:assert/strict";
import test from "node:test";
import { ownsInformationProcessingAttempt } from "./information-processing-jobs.ts";

const request = {
  runId: "knowledge-run:current",
  versionId: "knowledge-version:current",
  model: "gpt-5.6-luna",
  maxTokens: 1000,
  instructions: "instructions",
  input: "input",
};

test("information-processing application fencing rejects a late runner attempt", () => {
  const active = {
    job_id: "information-job:1",
    doc_id: "document:1",
    status: "running",
    attempt: 2,
    lease_owner: "runner-b",
    lease_until: Date.now() + 60_000,
    last_run_id: request.runId,
  };
  assert.equal(ownsInformationProcessingAttempt(request, active.job_id, active, "runner-b", 2), true);
  assert.equal(ownsInformationProcessingAttempt(request, active.job_id, active, "runner-a", 1), false);
});
