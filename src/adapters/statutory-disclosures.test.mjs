import assert from "node:assert/strict";
import test from "node:test";
import {
  cninfoNoticesToStatutoryDocuments,
  hkexRowsToStatutoryDocuments,
  fetchHkexStatutoryDisclosureIndex,
  parseHkexTitleSearchRows,
  statutoryRegistryForSecurity,
} from "./statutory-disclosures.ts";

test("maps each A-share security only to CNINFO and HK only to HKEX", () => {
  assert.equal(statutoryRegistryForSecurity("300308.SZ"), "cninfo");
  assert.equal(statutoryRegistryForSecurity("600000.SH"), "cninfo");
  assert.equal(statutoryRegistryForSecurity("00700.HK"), "hkex");
  assert.equal(statutoryRegistryForSecurity("MU.US"), null);
});

test("keeps CNINFO native ids, URLs and publication dates as auditable filing references", () => {
  const documents = cninfoNoticesToStatutoryDocuments("300308.SZ", [{
    artCode: "1212345678", title: "2025 年年度报告", noticeDate: "2026-04-10", noticeType: "定期报告",
    pdfUrl: "https://static.cninfo.com.cn/finalpage/2026-04-10/1212345678.PDF",
  }]);
  assert.deepEqual(documents[0], {
    registry: "cninfo", securityCode: "300308.SZ", documentId: "1212345678", title: "2025 年年度报告",
    publishedAt: "2026-04-10", documentUrl: "https://static.cninfo.com.cn/finalpage/2026-04-10/1212345678.PDF",
    documentType: "定期报告", sourceLocator: "CNINFO announcementId=1212345678",
  });
});

test("parses the HKEX public title-search envelope and preserves its native document reference", () => {
  const rows = parseHkexTitleSearchRows({ result: JSON.stringify([{
    NEWS_ID: "11753214", TITLE: "Next Day Disclosure Return", DATE_TIME: "10/07/2025 17:19",
    FILE_LINK: "/listedco/listconews/sehk/2025/0710/2025071000523.pdf", FILE_TYPE: "PDF",
  }]) });
  assert.deepEqual(hkexRowsToStatutoryDocuments("00700.HK", rows), [{
    registry: "hkex", securityCode: "00700.HK", documentId: "11753214", title: "Next Day Disclosure Return",
    publishedAt: "2025-07-10", documentUrl: "https://www1.hkexnews.hk/listedco/listconews/sehk/2025/0710/2025071000523.pdf",
    documentType: "PDF", sourceLocator: "HKEXnews NEWS_ID=11753214",
  }]);
});

test("rejects malformed HKEX envelopes instead of treating them as no filings", () => {
  assert.throws(() => parseHkexTitleSearchRows({ result: "not-json" }), /not valid JSON/);
  assert.throws(() => parseHkexTitleSearchRows({}), /did not contain a string result/);
});

test("returns an explicit non-retryable failure for an HKEX range the registry will not search", async () => {
  const result = await fetchHkexStatutoryDisclosureIndex({}, "00700.HK", {
    fromDate: "2024-01-01", toDate: "2026-01-01",
  });
  assert.equal(result.availability, "unavailable");
  assert.deepEqual(result.failure, {
    code: "invalid_date_range",
    message: "HKEX title search requires an inclusive date range of at most 366 days (YYYY-MM-DD).",
    retryable: false,
  });
});
