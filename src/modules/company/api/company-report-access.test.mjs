import assert from "node:assert/strict";
import test from "node:test";
import { projectCompanyReportItemsForSession } from "./company-report-access.ts";

const sourceItem = {
  code: "600519.SH",
  title: "测试研报",
  url: "https://stock.finance.sina.com.cn/report/842297790087",
  detailUrl: "https://example.test/detail",
  localUrl: "https://example.test/local",
  infoCode: "AP202609140001",
  encodeUrl: "encoded-provider-target",
  contentUrl: "https://content.tinfo.cc/private/report",
  contentKey: "private/report",
  llmRawResponse: { sourceUrl: "https://example.test/raw" },
  forecasts: [],
};

test("anonymous company report list contains no source address or recoverable report identifier", () => {
  const [item] = projectCompanyReportItemsForSession([sourceItem], false);
  assert.equal(item.reportLocked, true);
  for (const field of ["url", "detailUrl", "localUrl", "reportUrl", "sourceUrl", "pdfUrl", "infoCode", "encodeUrl", "reportId", "rptid", "rptId", "contentUrl", "contentKey", "llmRawResponse"]) {
    assert.equal(field in item, false, field);
  }
});

test("authenticated company report list provides one direct source address", () => {
  const [item] = projectCompanyReportItemsForSession([sourceItem], true);
  assert.equal(item.reportUrl, sourceItem.localUrl);
  assert.equal(item.reportLocked, undefined);
  assert.equal("url" in item, false);
  assert.equal("infoCode" in item, false);
});

test("authenticated mainland Eastmoney item receives its direct PDF address", () => {
  const [item] = projectCompanyReportItemsForSession([{ code: "600519.SH", infoCode: "AP202609140001" }], true);
  assert.equal(item.reportUrl, "https://pdf.dfcfw.com/pdf/H3_AP202609140001_1.pdf");
});
