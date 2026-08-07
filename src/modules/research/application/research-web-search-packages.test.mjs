import assert from "node:assert/strict";
import test from "node:test";

import { compactSourceCitations, parseResearchWebSearchPackage, webSearchPackageJobTimedOut } from "./research-web-search-packages.ts";
import { RESEARCH_WEB_SEARCH_LATEST_ANNUAL_REPORT_PROMPT, RESEARCH_WEB_SEARCH_SOURCE_PACKAGE_SYSTEM_PROMPT } from "../../../generated/prompt-text.ts";

const citation = { title: "监管原文", url: "https://regulator.example/notice?id=1" };

test("uses a native source link as verification without requesting a quote or locator", () => {
  const raw = JSON.stringify({
    summary: "结果保留。",
    evidence_records: [
      { tab_id: "risk", field_key: "uncited_fact", subject: "对象 A", statement: "模型返回了事实但没有本次 citation。", source_url: "https://unlinked.example/a" },
      { tab_id: "risk", field_key: "cited_fact", subject: "对象 B", statement: "模型已返回来源链接。", source_url: citation.url, status: "verified" },
      { tab_id: "risk", field_key: "missing_status", subject: "对象 C", statement: "模型遗漏状态，但仍有来源链接。", source_url: citation.url, quote: "不应保存的摘录", locator: "不应保存的定位" },
      { tab_id: "risk", field_key: "unavailable_with_context", subject: "对象 D", statement: "没有发现该事项。", numeric_value: null, status: "unavailable" },
      { tab_id: "市场", field_key: "invalid_tab", subject: "对象 E", statement: "无法映射到页面 Tab。", status: "verified" },
    ],
  });

  const parsed = parseResearchWebSearchPackage(raw, ["risk"], [citation]);
  assert.equal(parsed.items.length, 4);
  assert.deepEqual(parsed.items.map((item) => item.status), ["uncited", "verified", "verified", "unavailable"]);
  assert.equal(parsed.items[0].sourceUrl, "https://unlinked.example/a");
  assert.equal(parsed.items[1].sourceUrl, citation.url);
  assert.equal(parsed.items[2].quote, null);
  assert.equal(parsed.items[2].locator, null);
  assert.equal(parsed.items[3].numericValue, null);
});

test("rejects English user-facing output instead of persisting it", () => {
  const raw = JSON.stringify({ summary: "English summary", evidence_records: [{ tab_id: "risk", field_key: "risk", subject: "对象", statement: "English statement", source_url: citation.url }], missing_fields: [], conflicts: [], refresh_triggers: [] });
  assert.throws(() => parseResearchWebSearchPackage(raw, ["risk"], [citation]), /user-facing text was not Chinese/);
});

test("stores one source link per URL without citation positions", () => {
  assert.deepEqual(compactSourceCitations([
    { title: "来源", url: "https://example.test/report#page=1", start: 10, end: 20 },
    { title: "来源重复", url: "https://example.test/report", start: 30, end: 40 },
  ]), [{ title: "来源", url: "https://example.test/report" }]);
});

test("generated prompts require Chinese, omit quote and locator fields, and treat annual reports as a baseline", () => {
  assert.match(RESEARCH_WEB_SEARCH_SOURCE_PACKAGE_SYSTEM_PROMPT, /所有面向用户的文字必须使用简体中文/);
  assert.doesNotMatch(RESEARCH_WEB_SEARCH_SOURCE_PACKAGE_SYSTEM_PROMPT.split("输出严格 JSON：")[1].split("。status")[0], /quote|locator/);
  assert.match(RESEARCH_WEB_SEARCH_SOURCE_PACKAGE_SYSTEM_PROMPT, /不要输出原文摘录、页码、段落、行号、字符位置/);
  assert.match(RESEARCH_WEB_SEARCH_LATEST_ANNUAL_REPORT_PROMPT, /年报不是唯一来源/);
  assert.match(RESEARCH_WEB_SEARCH_LATEST_ANNUAL_REPORT_PROMPT, /公开研报、行业机构资料和权威媒体/);
});

test("rejects the complete package only when no structurally readable record remains", () => {
  const raw = JSON.stringify({ summary: "本次没有可映射记录。", evidence_records: [{ tab_id: "市场", field_key: "invalid_tab", subject: "对象", statement: "不可映射。" }] });
  assert.throws(() => parseResearchWebSearchPackage(raw, ["risk"], [citation]), /unsupported_tab=1/);
});

test("makes an unfinished package retryable after the configured job deadline", () => {
  const now = 2_000_000_000_000;
  assert.equal(webSearchPackageJobTimedOut({ status: "running", updatedAt: now - 600_000 }, now), true);
  assert.equal(webSearchPackageJobTimedOut({ status: "queued", createdAt: now - 600_001 }, now), true);
  assert.equal(webSearchPackageJobTimedOut({ status: "running", updatedAt: now - 599_999 }, now), false);
  assert.equal(webSearchPackageJobTimedOut({ status: "completed", updatedAt: now - 600_001 }, now), false);
});
