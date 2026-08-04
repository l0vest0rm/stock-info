import assert from "node:assert/strict";
import test from "node:test";

import { produceAhStatutoryVerifications } from "./a-h-statutory-verification.ts";

const fact = {
  id: "eastmoney:300308.SZ:income:2024-12-31:0:revenue",
  canonicalComparisonKey: "financial-comparison:v1:eastmoney:300308.SZ:income:2024-01-01:2024-12-31:revenue:CNY-CAS-consolidated-reported",
  metric: "revenue", value: 23_862_159_738.37,
  period: { kind: "annual", startDate: "2024-01-01", endDate: "2024-12-31", fiscalYear: 2024 },
  basis: { id: "CNY:CAS:consolidated:reported", currency: "CNY", accountingStandard: "CAS", scope: "consolidated", revision: "reported" },
  provenance: { sourceId: "eastmoney:300308.SZ:income:2024-12-31:0", sourceType: "eastmoney", locator: "TOTAL_OPERATE_INCOME" },
};

function dbWithSink() {
  const recorded = [];
  return {
    recorded,
    prepare(sql) {
      return {
        bind(...values) {
          if (sql.includes("from knowledge_docs")) return { first: async () => null };
          if (sql.includes("insert into research_financial_statutory_verifications")) return { run: async () => { recorded.push(values); return { success: true }; } };
          throw new Error(`unexpected statement: ${sql}`);
        },
      };
    },
  };
}

test("A-share producer appends CNINFO evidence and preserves Eastmoney primary provenance", async () => {
  const db = dbWithSink();
  const result = await produceAhStatutoryVerifications({ DB: db }, {
    securityCode: "300308.SZ", normalizedFacts: [fact], observedAt: 1_771_545_600_000, createdAt: 1_771_545_600_001,
    verificationIdForFact: () => "cninfo-300308-revenue-2024-v1",
    documents: [{
      registry: "cninfo", securityCode: "300308.SZ", documentId: "1223155483", title: "2024年年度报告", publishedAt: "2025-04-21",
      documentUrl: "https://static.cninfo.com.cn/finalpage/2025-04-21/1223155483.PDF", documentType: "年度报告", sourceLocator: "CNINFO announcementId=1223155483",
    }],
    loadPdfText: async () => ({ extractionMethod: "pdf_text", pages: ["合并利润表 营业总收入 23,862,159,738.37"] }),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].verification.outcome, "match");
  assert.equal(result[0].verification.normalizedFact.provenance.sourceType, "eastmoney");
  assert.equal(result[0].verification.statutoryDisclosure?.provider, "cninfo");
  assert.equal(db.recorded[0].includes("cninfo-300308-revenue-2024-v1"), true);
});

test("confirmed correction verification is appended as restated provenance and conflicts with an unsynchronized reported primary fact", async () => {
  const db = dbWithSink();
  const result = await produceAhStatutoryVerifications({ DB: db }, {
    securityCode: "300308.SZ", normalizedFacts: [fact], observedAt: 1_771_545_600_000, createdAt: 1_771_545_600_001,
    verificationIdForFact: () => "cninfo-300308-revenue-2024-restated",
    documents: [{
      registry: "cninfo", securityCode: "300308.SZ", documentId: "correction", title: "2024年年度报告（更正后）", publishedAt: "2025-05-01",
      documentUrl: "https://static.cninfo.com.cn/finalpage/2025-05-01/correction.PDF", documentType: "年度报告", sourceLocator: "CNINFO announcementId=correction",
    }],
    selectedDocumentId: "correction",
    confirmedRestatement: { revisionReviewId: "revision-review:1", originalDocumentId: "1223155483", affectedScope: "2024FY revenue" },
    loadPdfText: async () => ({ extractionMethod: "pdf_text", pages: ["合并利润表 营业总收入 23,862,159,739.37"] }),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].verification.outcome, "conflict");
  assert.equal(result[0].verification.statutoryDisclosure?.basis?.revision, "restated");
  assert.deepEqual(result[0].verification.metadata.statutoryRevision, {
    classification: "confirmed_financial_restatement", reviewId: "revision-review:1", originalDocumentId: "1223155483", affectedScope: "2024FY revenue",
  });
  assert.equal(db.recorded[0].includes("restated"), true);
});

test("CNINFO share capital is not relabeled as period-end diluted shares", async () => {
  const db = dbWithSink();
  const result = await produceAhStatutoryVerifications({ DB: db }, {
    securityCode: "300308.SZ", normalizedFacts: [{ ...fact, id: "eastmoney:300308.SZ:balance:2024-12-31:diluted_shares", metric: "diluted_shares", value: 1_000 }],
    observedAt: 1_771_545_600_000, createdAt: 1_771_545_600_001,
    verificationIdForFact: () => "cninfo-300308-diluted-shares-not-inferred",
    documents: [{
      registry: "cninfo", securityCode: "300308.SZ", documentId: "1223155483", title: "2024年年度报告", publishedAt: "2025-04-21",
      documentUrl: "https://static.cninfo.com.cn/finalpage/2025-04-21/1223155483.PDF", documentType: "年度报告", sourceLocator: "CNINFO announcementId=1223155483",
    }],
    loadPdfText: async () => ({ extractionMethod: "pdf_text", pages: ["合并资产负债表 股本 1,000"] }),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].verification.outcome, "unverified");
  assert.ok(result[0].verification.reasonCodes.includes("statutory_metric_mapping_not_configured"));
  assert.ok(result[0].verification.reasonCodes.includes("statutory_field_value_missing"));
});
