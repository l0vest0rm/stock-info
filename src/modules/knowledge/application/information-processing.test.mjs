import assert from "node:assert/strict";
import test from "node:test";

import { parseStructuredAnalysis } from "./information-processing.ts";

const record = (overrides = {}) => ({
  entity: "三环集团",
  informationType: "fact",
  category: "revenue",
  period: "2026H1",
  statement: "三环集团2026年上半年营业收入同比增长。",
  ...overrides,
});

test("accepts the minimal information record contract", () => {
  const result = parseStructuredAnalysis(JSON.stringify({ records: [record()] }));
  assert.equal(result.outcome, "extracted");
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].period, "2026H1");
});

test("treats an empty records array as no information", () => {
  const result = parseStructuredAnalysis('{"records":[]}');
  assert.equal(result.outcome, "no_information");
  assert.equal(result.records.length, 0);
});

test("marks invalid category/type and period-policy records for review", () => {
  const wrongType = parseStructuredAnalysis(JSON.stringify({ records: [record({ informationType: "opinion" })] }));
  const missingPeriod = parseStructuredAnalysis(JSON.stringify({ records: [record({ period: null })] }));
  const forbiddenPeriod = parseStructuredAnalysis(JSON.stringify({ records: [record({ category: "analyst_rating", informationType: "opinion", period: "2026H1" })] }));
  const nonSelfContainedStatement = parseStructuredAnalysis(JSON.stringify({ records: [record({ statement: "2026年上半年营业收入同比增长。" })] }));
  assert.equal(wrongType.outcome, "needs_review");
  assert.equal(missingPeriod.outcome, "needs_review");
  assert.equal(forbiddenPeriod.outcome, "needs_review");
  assert.equal(nonSelfContainedStatement.outcome, "needs_review");
});

test("accepts supported simple periods and rejects malformed JSON", () => {
  for (const period of ["2026Q1", "截至2026-07-31", "最近3个月", "2026年上半年"]) {
    assert.equal(parseStructuredAnalysis(JSON.stringify({ records: [record({ period })] })).outcome, "extracted");
  }
  assert.throws(() => parseStructuredAnalysis('{"records":[}'), /document analysis must be valid JSON/);
});
