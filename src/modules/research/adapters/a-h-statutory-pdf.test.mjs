import assert from "node:assert/strict";
import test from "node:test";

import { collectAhStatutoryPdfDisclosure } from "./a-h-statutory-pdf.ts";

const cnDocument = {
  registry: "cninfo", securityCode: "300308.SZ", documentId: "1223155483", title: "2024年年度报告",
  publishedAt: "2025-04-21", documentUrl: "https://static.cninfo.com.cn/finalpage/2025-04-21/1223155483.PDF",
  documentType: "年度报告", sourceLocator: "CNINFO announcementId=1223155483",
};
const hkDocument = {
  registry: "hkex", securityCode: "00700.HK", documentId: "12200001", title: "Annual Report 2024",
  publishedAt: "2025-04-01", documentUrl: "https://www1.hkexnews.hk/annual-report-2024.pdf",
  documentType: "PDF", sourceLocator: "HKEXnews NEWS_ID=12200001",
};

function fact(metric, value = 100, overrides = {}) {
  return {
    id: `eastmoney:sample:${metric}:2024`, metric, value,
    period: { kind: "annual", startDate: "2024-01-01", endDate: "2024-12-31", fiscalYear: 2024 },
    basis: { id: "CNY:CAS:consolidated:reported", currency: "CNY", accountingStandard: "CAS", scope: "consolidated", revision: "reported" },
    provenance: { sourceId: `eastmoney:${metric}:2024`, sourceType: "eastmoney", locator: metric },
    ...overrides,
  };
}

test("CNINFO annual PDF returns a page-and-label-bound A-share field", async () => {
  const result = await collectAhStatutoryPdfDisclosure("300308.SZ", fact("revenue"), [cnDocument], async () => ({
    extractionMethod: "pdf_text",
    pages: ["封面", "合并利润表 单位：元 项目 2024年度 2023年度 营业总收入 23,862,159,738.37 10,717,984,471.03"],
  }));
  assert.equal(result.disclosure?.provider, "cninfo");
  assert.equal(result.disclosure?.value, 23_862_159_738.37);
  assert.match(result.disclosure?.locator ?? "", /page=2; statement=income; label=营业总收入/);
  assert.equal(result.disclosure?.basis?.accountingStandard, "CAS");
});

test("CNINFO does not mistake a disclosure notice for the statutory report", async () => {
  const result = await collectAhStatutoryPdfDisclosure("300308.SZ", fact("revenue"), [{
    ...cnDocument, documentId: "notice", title: "2024年年度报告披露的提示性公告",
  }, cnDocument], async (document) => ({
    extractionMethod: "pdf_text", pages: [`合并利润表 营业总收入 ${document.documentId === "1223155483" ? "100" : "999"}`],
  }));
  assert.equal(result.disclosure?.documentId, "1223155483");
  assert.equal(result.disclosure?.value, 100);
});

test("a confirmed correction can be selected explicitly and is marked restated without changing normal selection", async () => {
  const correction = {
    ...cnDocument, documentId: "correction", title: "2024年年度报告（更正后）", publishedAt: "2025-05-01",
  };
  const result = await collectAhStatutoryPdfDisclosure("300308.SZ", fact("revenue", 100), [cnDocument, correction], async (document) => ({
    extractionMethod: "pdf_text", pages: [`合并利润表 营业总收入 ${document.documentId === "correction" ? "110" : "100"}`],
  }), {
    selectedDocumentId: "correction",
    confirmedRestatement: { revisionReviewId: "review:correction", originalDocumentId: cnDocument.documentId, affectedScope: "2024FY revenue" },
  });
  assert.equal(result.disclosure?.documentId, "correction");
  assert.equal(result.disclosure?.value, 110);
  assert.equal(result.disclosure?.basis?.revision, "restated");
  assert.equal(result.disclosure?.metadata?.statutoryRevisionReviewId, "review:correction");
  assert.equal(result.metadata.revisionClassification, "confirmed_financial_restatement");
});

test("CNINFO derives a standalone A-share Q2 flow from two cumulative statutory reports", async () => {
  const q1 = {
    ...cnDocument, documentId: "q1", title: "2025年一季度报告", publishedAt: "2025-04-20",
  };
  const h1 = {
    ...cnDocument, documentId: "h1", title: "2025年半年度报告", publishedAt: "2025-08-27",
  };
  const result = await collectAhStatutoryPdfDisclosure("300308.SZ", fact("revenue", 60, {
    period: { kind: "quarter", fiscalQuarter: 2, startDate: "2025-04-01", endDate: "2025-06-30", fiscalYear: 2025 },
  }), [q1, h1], async (document) => ({
    extractionMethod: "pdf_text",
    pages: [`合并利润表 营业总收入 ${document.documentId === "h1" ? "100" : "40"}`],
  }));
  assert.equal(result.disclosure?.value, 60);
  assert.match(result.disclosure?.locator ?? "", /formula=current_cumulative-prior_cumulative; prior_document=q1/);
  assert.equal(result.disclosure?.metadata?.periodAggregation, "standalone_quarter_from_cumulative_statutory_reports");
  assert.equal(result.disclosure?.metadata?.predecessorDocumentId, "q1");
});

test("CNINFO leaves an A-share Q2 flow unverified when the predecessor filing is unavailable", async () => {
  const h1 = {
    ...cnDocument, documentId: "h1", title: "2025年半年度报告", publishedAt: "2025-08-27",
  };
  const result = await collectAhStatutoryPdfDisclosure("300308.SZ", fact("revenue", 60, {
    period: { kind: "quarter", fiscalQuarter: 2, startDate: "2025-04-01", endDate: "2025-06-30", fiscalYear: 2025 },
  }), [h1], async () => ({
    extractionMethod: "pdf_text", pages: ["合并利润表 营业总收入 100"],
  }));
  assert.equal(result.disclosure?.value, null);
  assert.deepEqual(result.reasonCodes, ["statutory_predecessor_filing_not_indexed"]);
});

test("CNINFO accepts the statutory parent-profit label variant across cumulative reports", async () => {
  const q1 = { ...cnDocument, documentId: "q1", title: "2025年一季度报告", publishedAt: "2025-04-20" };
  const h1 = { ...cnDocument, documentId: "h1", title: "2025年半年度报告", publishedAt: "2025-08-27" };
  const result = await collectAhStatutoryPdfDisclosure("300308.SZ", fact("net_profit", 60, {
    period: { kind: "quarter", fiscalQuarter: 2, startDate: "2025-04-01", endDate: "2025-06-30", fiscalYear: 2025 },
  }), [q1, h1], async (document) => ({
    extractionMethod: "pdf_text",
    pages: [`合并利润表 ${document.documentId === "h1" ? "归属于母公司股东的净利润 100" : "归属于母公司所有者的净利润 40"}`],
  }));
  assert.equal(result.disclosure?.value, 60);
  assert.equal(result.disclosure?.metadata?.predecessorMatchedLabel, "归属于母公司所有者的净利润");
});

test("CNINFO extractor excludes ratio rows and parent-only equity when the consolidated fact has a distinct label", async () => {
  const operating = await collectAhStatutoryPdfDisclosure("300308.SZ", fact("operating_profit", 200), [cnDocument], async () => ({
    extractionMethod: "pdf_text", pages: ["合并利润表 营业利润率 48.77 营业利润 200"],
  }));
  assert.equal(operating.disclosure?.value, 200);
  const equity = await collectAhStatutoryPdfDisclosure("300308.SZ", fact("total_equity", 300), [cnDocument], async () => ({
    extractionMethod: "pdf_text", pages: ["合并资产负债表 归属于母公司所有者权益合计 280 所有者权益合计 300"],
  }));
  assert.equal(equity.disclosure?.value, 300);
});

test("HKEX annual PDF maps a consolidated field without changing the primary source", async () => {
  const result = await collectAhStatutoryPdfDisclosure("00700.HK", fact("revenue", 100, {
    basis: { id: "HKD:IFRS:consolidated:reported", currency: "HKD", accountingStandard: "IFRS", scope: "consolidated", revision: "reported" },
  }), [hkDocument], async () => ({
    extractionMethod: "knowledge_preprocessed_text",
    pages: ["Consolidated statement of profit or loss (HKD in millions) IFRS Revenue 660,257 609,015"],
  }));
  assert.equal(result.disclosure?.provider, "hkex");
  assert.equal(result.disclosure?.value, 660_257_000_000);
  assert.equal(result.disclosure?.basis?.currency, "HKD");
  assert.equal(result.disclosure?.metadata?.unitMultiplier, 1_000_000);
  assert.equal(result.metadata.extractionMethod, "knowledge_preprocessed_text");
});

const hkQ1Document = {
  ...hkDocument, documentId: "12157226", title: "First Quarterly Results Announcement 2026", publishedAt: "2026-05-13",
};
const tencentQ1Markdown = `
## CONDENSED CONSOLIDATED INCOME STATEMENT FOR THE THREE MONTHS ENDED 31 MARCH 2026
|||Unaudited|Unaudited||
|||Three months ended||31 March|
|||2026||2025|
||Note|RMB’Million|RMB’Million||
|Revenues|||||
|Value-added Services||96,110||92,133|
|Marketing Services||38,171||31,853|
|FinTech and Business Services||59,885||54,907|
|Others||2,292||1,129|
||2|196,458||180,022|
|Cost of revenues|3|(85,193)||(79,529)|
|Gross profit||111,265||100,493|
|Operating profit||67,375||57,566|
|Attributable to:|||||
|Equity holders of the Company||58,093||47,821|
|Earnings per share for profit attributable|||||
|to equity holders of the Company|||||
|(RMB per share)|||||

## CONDENSED CONSOLIDATED STATEMENT OF CASH FLOWS FOR THE THREE MONTHS ENDED 31 MARCH 2026
|Net cash flows generated from operating activities<br>Net cash flows used in investing activities<br>Net cash flows used in financing activities|Unaudited<br>Three months ended 31 March<br>2026<br>2025<br>RMB’Million<br>RMB’Million<br>101,351<br>76,889<br>(10,560)<br>(29,499)<br>(12,117)<br>24,818|
|---|---|

The interim financial information has been prepared in accordance with IFRS Accounting Standards.`;

function hkQ1Fact(metric) {
  return fact(metric, 1, {
    id: `eastmoney:00700.HK:${metric}:2026q1`,
    period: { kind: "quarter", fiscalQuarter: 1, startDate: "2026-01-01", endDate: "2026-03-31", fiscalYear: 2026 },
    basis: { id: "人民币:国际会计准则:consolidated:reported", currency: "人民币", accountingStandard: "国际会计准则", scope: "consolidated", revision: "reported" },
  });
}

test("HKEX Markdown fields preserve source RMB million basis and normalize to base units", async () => {
  const expectations = new Map([
    ["revenue", 196_458_000_000], ["gross_profit", 111_265_000_000], ["net_profit", 58_093_000_000], ["operating_cash_flow", 101_351_000_000],
  ]);
  for (const [metric, expected] of expectations) {
    const result = await collectAhStatutoryPdfDisclosure("00700.HK", hkQ1Fact(metric), [hkQ1Document], async () => ({
      extractionMethod: "local_pdf_conversion", pages: [tencentQ1Markdown], pageNumbersReliable: false,
    }));
    assert.equal(result.disclosure?.value, expected, metric);
    assert.equal(result.disclosure?.basis?.currency, "CNY", metric);
    assert.equal(result.disclosure?.basis?.accountingStandard, "IFRS", metric);
    assert.equal(result.disclosure?.metadata?.rawReportedValue, expected / 1_000_000, metric);
  }
});

test("HKEX does not invent a currency or unit when the selected report omits it", async () => {
  const result = await collectAhStatutoryPdfDisclosure("00700.HK", hkQ1Fact("gross_profit"), [hkQ1Document], async () => ({
    extractionMethod: "knowledge_preprocessed_text", pages: ["Consolidated income statement IFRS |Gross profit||111,265||100,493|\n|---|---|---|---|"],
  }));
  assert.equal(result.disclosure?.value, null);
  assert.deepEqual(result.reasonCodes, ["statutory_measurement_basis_not_found"]);
});

test("missing mapped filing is retained as an auditable unavailable observation", async () => {
  const result = await collectAhStatutoryPdfDisclosure("300308.SZ", fact("revenue"), [], async () => {
    throw new Error("must not fetch without a registry document");
  });
  assert.equal(result.disclosure, null);
  assert.deepEqual(result.reasonCodes, ["statutory_filing_not_indexed"]);
});

test("an indexed filing without a mapped table is not mislabelled as a conflict", async () => {
  const result = await collectAhStatutoryPdfDisclosure("300308.SZ", fact("revenue"), [cnDocument], async () => ({
    extractionMethod: "pdf_text", pages: ["2024年年度报告 附注：营业总收入的披露见后附表"],
  }));
  assert.equal(result.disclosure?.value, null);
  assert.deepEqual(result.reasonCodes, ["statutory_statement_table_not_found"]);
});
