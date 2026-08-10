import assert from "node:assert/strict";
import test from "node:test";

import { buildCompanyReportDiscoveryWebQaSearch, buildCompanyReportDiscoveryWebSearch, webQaJob } from "./company-report-discovery-runner.mjs";

test("completed normalized Web Search metadata remains valid when raw call item is absent", () => {
  const metadata = buildCompanyReportDiscoveryWebSearch({
    raw: { status: "completed" },
    webSearch: { searched: true, queries: ["中际旭创 研报"], citations: [] },
  });
  assert.equal(metadata.responseCompleted, true);
  assert.equal(metadata.responseStatus, "completed");
  assert.equal(metadata.webSearchCallCompleted, true);
  assert.deepEqual(metadata.citations, []);
});

test("unfinished or no-search metadata is not promoted to a completed Web Search", () => {
  const unfinished = buildCompanyReportDiscoveryWebSearch({
    raw: { status: "in_progress" },
    webSearch: { searched: true, queries: ["中际旭创 研报"], citations: [] },
  });
  assert.equal(unfinished.responseCompleted, false);
  assert.equal(unfinished.webSearchCallCompleted, false);

  const noSearch = buildCompanyReportDiscoveryWebSearch({
    raw: { status: "completed" },
    webSearch: { searched: false, queries: [], citations: [] },
  });
  assert.equal(noSearch.responseCompleted, true);
  assert.equal(noSearch.webSearchCallCompleted, false);
  assert.equal(noSearch.searched, false);
});

test("completed WebQA discovery retains gateway sources and has an explicit terminal signal", () => {
  const metadata = buildCompanyReportDiscoveryWebQaSearch({
    status: "completed",
    answer: {
      citations: [{ title: "机构研报", url: "https://reports.example.com/acme.pdf" }],
      sources: [{ name: "重复来源", href: "https://reports.example.com/acme.pdf" }],
    },
  });
  assert.equal(metadata.searched, true);
  assert.equal(metadata.responseCompleted, true);
  assert.equal(metadata.webSearchCallCompleted, true);
  assert.equal(metadata.transport, "webqa");
  assert.deepEqual(metadata.citations, [{ title: "机构研报", url: "https://reports.example.com/acme.pdf" }]);
});

test("a requeued discovery attempt gets a fresh WebQA idempotency key", () => {
  const base = { idempotencyKey: "company-report-discovery:2026-05-12", attempt: 3, model: "gpt-5.6-luna", input: "prompt", instructions: "instructions", reasoningEffort: "xhigh" };
  assert.equal(webQaJob(base).idempotencyKey, "company-report-discovery:2026-05-12:attempt:3");
});
