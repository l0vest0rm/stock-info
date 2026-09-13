import assert from "node:assert/strict";
import test from "node:test";
import {
  hasRecoverableTaskdReportCheckpoint,
  isObservedTaskdReportTask,
  isPendingTaskdReportTask,
  isTerminalTaskdReportTask,
} from "./taskd-report-workflow";

test("taskd report workflow recognizes only safe provider recovery checkpoints", () => {
  assert.equal(hasRecoverableTaskdReportCheckpoint({ provider_url: "https://chatgpt.com/c/example" }), true);
  assert.equal(hasRecoverableTaskdReportCheckpoint({ submission: { schema_version: "provider_submission.v1", marker: "sent", state: "click_issued" } }), true);
  assert.equal(hasRecoverableTaskdReportCheckpoint({ submission: { schema_version: "provider_submission.v1", marker: "sent", state: "draft" } }), false);
  assert.equal(hasRecoverableTaskdReportCheckpoint({}), false);
});

test("taskd report workflow fences a different run and classifies polling states", () => {
  const expected = { taskId: 23, name: "research:financial-analysis:300308.SZ", createdAt: 100 };
  assert.equal(isObservedTaskdReportTask(expected, { ...expected }), true);
  assert.equal(isObservedTaskdReportTask(expected, { ...expected, taskId: 24 }), false);
  assert.equal(isPendingTaskdReportTask({ status: "running" }), true);
  assert.equal(isTerminalTaskdReportTask({ status: "succeeded" }), true);
  assert.equal(isPendingTaskdReportTask({ status: "failed" }), false);
});
