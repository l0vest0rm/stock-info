import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  shouldKeepOriginalReportPdf,
  topicFilterBypassDecision,
  topicFilterKeywordDecision,
} from "./knowledge-topic-filter.mjs";

const processingConfig = JSON.parse(readFileSync(new URL("../../config/knowledge-processing.json", import.meta.url), "utf8"));

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

test("blacklist rejects public-agency discipline investigations before import", () => {
  const decision = topicFilterKeywordDecision({
    title: "国家税务总局新疆维吾尔自治区税务局原副局长张英俊被查",
    summary: "张英俊涉嫌严重违纪违法，目前正接受纪律审查和监察调查。",
    tags: ["财联社电报", "新疆", "纪委动态"],
  }, processingConfig.topicFilter);

  assert.equal(decision.blocked, true);
  assert.deepEqual(decision.reasons, ["黑名单:public_agency_discipline_investigation"]);
});

test("blacklist leaves corporate governance investigations for the model", () => {
  const decision = topicFilterKeywordDecision({
    title: "中国石油勘探开发研究院原党委委员、总会计师曹建国接受纪律审查和监察调查",
    tags: ["财联社电报", "纪委动态"],
  }, processingConfig.topicFilter);

  assert.equal(decision.blocked, false);
});

test("blacklist preserves a stock-market item from source metadata", () => {
  const decision = topicFilterKeywordDecision({
    title: "理文造纸宣布中期派息",
    tags: ["港股动态", "造纸"],
  }, processingConfig.topicFilter);

  assert.equal(decision.blocked, false);
  assert.ok(decision.reasons.includes("市场信号:港股"));
});

test("blacklist preserves source-linked stocks without a financial title", () => {
  const decision = topicFilterKeywordDecision({
    title: "公司发布最新公告",
    metadata: { stockList: [{ StockID: "600519" }] },
  }, processingConfig.topicFilter);

  assert.equal(decision.blocked, false);
  assert.ok(decision.reasons.includes("股票关联"));
});

test("blacklist rejects the unrelated humanitarian official meeting", () => {
  const decision = topicFilterKeywordDecision({
    title: "缅甸官方：昂山素季会见红十字国际委员会驻缅代表",
    tags: ["财联社电报"],
  }, processingConfig.topicFilter);

  assert.equal(decision.blocked, true);
  assert.deepEqual(decision.reasons, ["黑名单:humanitarian_official_meeting"]);
});

test("blacklist leaves non-blacklisted AI and market news for the model", () => {
  for (const title of [
    "马斯克表示，大模型Grok 4.6将于一周后推出。",
    "韩国KOSPI指数收跌1.23% SK海力士跌5.64%",
    "中共中央政治局：深化资本市场投融资综合改革 提升资本市场韧性和信心",
  ]) {
    const decision = topicFilterKeywordDecision({ title, tags: ["财联社电报"] }, processingConfig.topicFilter);
    assert.equal(decision.blocked, false, title);
  }
});
