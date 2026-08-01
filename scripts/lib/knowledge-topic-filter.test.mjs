import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldKeepOriginalReportPdf,
  topicFilterBypassDecision,
  topicFilterKeywordDecision,
} from "./knowledge-topic-filter.mjs";

const filter = {
  bypassSourceTypes: ["research_report"],
  bypassReportTypes: ["company_report", "industry_report", "research_report"],
};

test("news continues through the existing topic filter", () => {
  assert.equal(topicFilterBypassDecision({ sourceType: "local_news", reportType: "news" }, filter), null);
});

test("all configured report types bypass the topic filter", () => {
  for (const doc of [
    { sourceType: "research_report", reportType: "other" },
    { sourceType: "other", reportType: "company_report" },
    { sourceType: "other", reportType: "industry_report" },
    { sourceType: "other", reportType: "research_report" },
  ]) {
    assert.deepEqual(topicFilterBypassDecision(doc, filter), {
      keep: true,
      method: "report_bypass",
      score: 0,
      reasons: ["研报不执行主题过滤"],
    });
  }
});

test("remote report PDFs stay as original links when conversion is disabled", () => {
  assert.equal(shouldKeepOriginalReportPdf({
    sourceType: "research_report",
    reportType: "company_report",
    url: "https://example.com/report.pdf?download=1",
  }, { reportPdfMode: "original_link" }), true);
  assert.equal(shouldKeepOriginalReportPdf({
    sourceType: "local_news",
    reportType: "news",
    url: "https://example.com/news.pdf",
  }, { reportPdfMode: "original_link" }), false);
  assert.equal(shouldKeepOriginalReportPdf({
    sourceType: "research_report",
    reportType: "company_report",
    url: "https://example.com/report.pdf",
  }, { reportPdfMode: "markdown" }), false);
});

test("institutional priority keyword survives a matching topic denial", () => {
  const decision = topicFilterKeywordDecision(
    { title: "招商银行发布半年报" },
    {
      coreKeywords: ["招商银行"],
      denyBypassKeywords: ["招商银行"],
      denyKeywords: ["银行"],
    }
  );

  assert.equal(decision.score, 2);
  assert.deepEqual(decision.reasons, ["核心:招商银行", "优先:招商银行"]);
});

test("topic denial continues to apply when no priority keyword matches", () => {
  const decision = topicFilterKeywordDecision(
    { title: "银行行业周报" },
    { coreKeywords: ["行业"], denyKeywords: ["银行"] }
  );

  assert.equal(decision.score, 0);
  assert.deepEqual(decision.reasons, ["核心:行业", "排除:银行"]);
});
