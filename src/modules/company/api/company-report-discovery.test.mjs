import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalCompanyReportUrl,
  companyReportDedupKeys,
  mergeCompanyReportsPreferPrimary,
  parseCompanyReportDiscovery,
} from "./company.routes.ts";

const citations = [
  { title: "公开研报", url: "https://reports.example.com/acme.pdf?utm_source=search#page=1" },
];

test("parses cited discovery reports with the normal forecast and valuation fields", () => {
  const reports = parseCompanyReportDiscovery(JSON.stringify({
    reports: [{
      title: "公司深度研究",
      institution: "示例证券",
      publishedAt: "2026-06-20",
      url: "https://reports.example.com/acme.pdf#page=1",
      forecasts: [{ year: 2026, revenue: 12.3, netProfit: 1.1, eps: 0.4, pe: 20 }],
      valuation: { rating: "买入", targetPrice: 18.5, targetPriceCurrency: "人民币", targetPe: 20, valuationMethod: "PE" },
    }],
  }), "000001.SZ", citations);
  assert.deepEqual(reports, [{
    title: "公司深度研究",
    institution: "示例证券",
    publishedAt: "2026-06-20",
    url: "https://reports.example.com/acme.pdf",
    forecasts: [{ year: 2026, revenue: 12.3, netProfit: 1.1, eps: 0.4, pe: 20 }],
    valuation: { rating: "买入", targetPrice: 18.5, targetPriceCurrency: "人民币", targetPe: 20, valuationMethod: "PE" },
  }]);
});

test("rejects candidates missing required metadata or a native citation", () => {
  const reports = parseCompanyReportDiscovery(JSON.stringify({
    reports: [
      { title: "缺机构", publishedAt: "2026-06-20", url: "https://reports.example.com/acme.pdf", forecasts: [] },
      { title: "无 citation", institution: "示例证券", publishedAt: "2026-06-21", url: "https://other.example.com/report.pdf", forecasts: [] },
    ],
  }), "000001.SZ", citations);
  assert.deepEqual(reports, []);
});

test("canonicalizes tracking URL variants and keeps same-title different-date reports", () => {
  assert.equal(
    canonicalCompanyReportUrl("HTTPS://Reports.Example.com/acme.pdf?utm_source=x&b=2&a=1#fragment"),
    "https://reports.example.com/acme.pdf?a=1&b=2",
  );
  const merged = mergeCompanyReportsPreferPrimary([
    { code: "000001.SZ", title: "公司深度研究", orgName: "示例证券", publishDate: "2026-06-20", url: "https://reports.example.com/acme.pdf?utm_source=x", provenance: "existing" },
  ], [
    { code: "000001.SZ", title: "公司深度研究", orgName: "示例证券", publishDate: "2026-06-20", url: "https://reports.example.com/acme.pdf#page=2", forecasts: [{ year: 2026, eps: 0.4 }], provenance: "web_search" },
    { code: "000001.SZ", title: "公司深度研究", orgName: "示例证券", publishDate: "2026-06-21", url: "https://reports.example.com/acme-2.pdf", provenance: "web_search" },
  ]);
  assert.equal(merged.length, 2);
  const duplicate = merged.find((item) => item.publishDate === "2026-06-20");
  assert.equal(duplicate?.provenance, "existing");
  assert.deepEqual(duplicate?.forecasts, [{ year: 2026, eps: 0.4 }]);
});

test("does not use title-only fallback when one date is missing", () => {
  const dated = { code: "000001.SZ", title: "同名研报", orgName: "示例证券", publishDate: "2026-06-20" };
  const undated = { code: "000001.SZ", title: "同名研报", orgName: "示例证券" };
  assert.notDeepEqual(companyReportDedupKeys(dated), companyReportDedupKeys(undated));
  assert.equal(mergeCompanyReportsPreferPrimary([dated], [undated]).length, 2);
});

test("uses code/title/institution fallback only when both dates are unavailable", () => {
  const first = { code: "000001.SZ", title: "同名研报", orgName: "示例证券" };
  const second = { code: "000001.SZ", title: "同名研报", orgName: "示例证券", forecasts: [{ year: 2027, eps: 0.5 }] };
  assert.equal(mergeCompanyReportsPreferPrimary([first], [second]).length, 1);
});
