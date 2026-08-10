import assert from "node:assert/strict";
import test from "node:test";

import { buildCompanyReportDiscoveryWebSearch } from "./company-report-discovery-runner.mjs";

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
