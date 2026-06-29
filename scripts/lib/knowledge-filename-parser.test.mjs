import test from "node:test";
import assert from "node:assert/strict";

import { parseKnowledgeFilename } from "./knowledge-filename-parser.mjs";

test("parses company report metadata from standard filename", () => {
  const parsed = parseKnowledgeFilename("20260601-瑞银-宏发股份(600885)2026年AIC收入软性指引上调.pdf");
  assert.equal(parsed.publishedAt, "2026-06-01");
  assert.equal(parsed.sourceName, "瑞银");
  assert.equal(parsed.targetName, "宏发股份");
  assert.equal(parsed.targetCode, "600885.SH");
  assert.equal(parsed.reportType, "company_report");
  assert.equal(parsed.title, "宏发股份(600885)2026年AIC收入软性指引上调");
});

test("parses split company code filenames", () => {
  const parsed = parseKnowledgeFilename("20260615-群益证券-芯原股份-688521-中美算力竞争利好公司，目前估值较低.pdf");
  assert.equal(parsed.publishedAt, "2026-06-15");
  assert.equal(parsed.sourceName, "群益证券");
  assert.equal(parsed.targetName, "芯原股份");
  assert.equal(parsed.targetCode, "688521.SH");
  assert.equal(parsed.reportType, "company_report");
  assert.equal(parsed.title, "中美算力竞争利好公司，目前估值较低");
});

test("parses industry report prefixes without inventing target", () => {
  const parsed = parseKnowledgeFilename("深度行业-20260530-国泰海通证券-OpenAI行业深度研究报告：OpenAI，AI时代的基础设施与超级入口.pdf");
  assert.equal(parsed.publishedAt, "2026-05-30");
  assert.equal(parsed.sourceName, "国泰海通证券");
  assert.equal(parsed.targetName, "");
  assert.equal(parsed.targetCode, "");
  assert.equal(parsed.reportType, "industry_report");
  assert.equal(parsed.title, "OpenAI行业深度研究报告：OpenAI，AI时代的基础设施与超级入口");
});
