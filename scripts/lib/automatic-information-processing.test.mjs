import assert from "node:assert/strict";
import test from "node:test";
import { AUTOMATIC_INFORMATION_PROCESSING_BATCH_SIZE, runAutomaticInformationProcessing } from "./automatic-information-processing.mjs";

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ code: status === 200 ? 200 : status, data }) };
}

test("automatic processing splits a run into durable one-document cursor steps", async () => {
  const requests = [];
  const replies = [
    { requested: 1, results: [{ status: "completed", needsReview: false }], cursor_reset: false },
    { requested: 1, results: [{ status: "completed", needsReview: true }], cursor_reset: false },
    { requested: 0, results: [], cursor_reset: true },
  ];
  const result = await runAutomaticInformationProcessing({
    enabled: true, maxDocuments: 200, requestTimeoutMs: 5_000,
    fetchImpl: async (_url, init) => { requests.push({ body: JSON.parse(init.body), signal: init.signal }); return response(replies.shift()); },
  });
  assert.equal(AUTOMATIC_INFORMATION_PROCESSING_BATCH_SIZE, 1);
  assert.equal(requests.length, 3);
  assert.equal(requests.every((request) => request.body.maxDocuments === 1), true);
  assert.equal(requests.every((request) => request.signal instanceof AbortSignal), true);
  assert.equal(result.status, "completed");
  assert.equal(result.requested, 2);
  assert.equal(result.processed, 2);
  assert.equal(result.needsReview, 1);
  assert.equal(result.batches, 3);
  assert.equal(result.cursorReset, true);
});

test("automatic processing reports a bounded request failure without an uncaught fetch exception", async () => {
  const result = await runAutomaticInformationProcessing({ enabled: true, maxDocuments: 10, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(result.status, "incomplete");
  assert.equal(result.failedStep, 1);
  assert.match(result.error, /automatic processing request failed: fetch failed/);
  assert.equal(result.requested, 0);
});

test("automatic processing never calls the local endpoint when disabled, remote, or explicitly zero", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("must not fetch"); };
  assert.equal((await runAutomaticInformationProcessing({ enabled: false, fetchImpl })).skipped, "disabled");
  assert.equal((await runAutomaticInformationProcessing({ enabled: true, remote: true, fetchImpl })).skipped, "remote_import");
  assert.equal((await runAutomaticInformationProcessing({ enabled: true, maxDocuments: 0, fetchImpl })).skipped, "max_documents_zero");
  assert.equal(calls, 0);
});
