import assert from "node:assert/strict";
import test from "node:test";
import { isPresentableResearchSource, researchSourcePresentationEligibility } from "./research-source-provenance";

test("keeps synthetic fixtures and sample seeds out of normal research presentation", () => {
  assert.deepEqual(researchSourcePresentationEligibility({ docId: "fixture-report-a", sourceUrl: "https://publisher.example.test/report" }), {
    eligible: false, reason: "fixture_document",
  });
  assert.deepEqual(researchSourcePresentationEligibility({ docId: "doc:sample", sourceUrl: "https://publisher.test/report", discoveryMethod: "local_seed" }), {
    eligible: false, reason: "sample_seed",
  });
  assert.deepEqual(researchSourcePresentationEligibility({ docId: "doc:untrusted", sourceUrl: "https://example.com/research.pdf" }), {
    eligible: false, reason: "reserved_example_domain",
  });
});

test("does not hide ordinary local evidence based on source text or institution-like names", () => {
  assert.equal(isPresentableResearchSource({
    docId: "knowledge:local-user-upload", sourceUrl: "https://research.example.cn/report.pdf",
    discoveryMethod: "manual_upload", metadataJson: JSON.stringify({ source: "local" }),
  }), true);
  assert.equal(isPresentableResearchSource({
    docId: "knowledge:甲机构", sourceUrl: "https://publisher.example.cn/report.pdf",
  }), true);
});
