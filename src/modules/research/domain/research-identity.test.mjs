import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFinancialCoverage,
  classifyResearchSecurity,
  financialSourcePolicyForMarket,
  resolveResearchInstrumentKind,
  validateSecurityRightsEvidence,
} from "./research-identity.ts";
import { normalizeSecurityRightsLinkForSelectedSecurity } from "../application/research-identity.ts";

test("routes A, H and US financial statements without automatic fallback", () => {
  assert.deepEqual(
    ["a_share", "h_share", "us_share"].map((market) => {
      const policy = financialSourcePolicyForMarket(market);
      return [policy.primaryProvider, policy.verificationProvider, policy.runtimeIntegration, policy.noAutomaticFallback];
    }),
    [
      ["eastmoney", "cninfo", "integrated", true],
      ["eastmoney", "hkex", "integrated", true],
      ["yahoo", "sec", "integrated", true],
    ],
  );
});

test("classifies company equities while rejecting funds, ETFs and indices", () => {
  assert.equal(classifyResearchSecurity({ code: "300308.SZ", instrumentType: "stock" }).market, "a_share");
  assert.equal(classifyResearchSecurity({ code: "00700.HK", instrumentType: "stock" }).market, "h_share");
  assert.equal(classifyResearchSecurity({ code: "NVDA.US", instrumentType: "stock" }).market, "us_share");
  assert.equal(classifyResearchSecurity({ code: "BABA.US", instrumentType: "adr" }).instrumentKind, "adr");
  assert.throws(() => classifyResearchSecurity({ code: "510300.SH", instrumentType: "fund" }), /rejects|only supports/);
  assert.throws(() => classifyResearchSecurity({ code: "SPX.US", instrumentType: "index" }), /only supports/);
  assert.throws(() => classifyResearchSecurity({ code: "QQQ.US", name: "Invesco QQQ ETF", instrumentType: "etf" }), /only supports/);
});

test("keeps a source-bound persisted ADR classification over a generic search stock label", () => {
  assert.equal(resolveResearchInstrumentKind("equity", "adr"), "adr");
  assert.equal(resolveResearchInstrumentKind("equity", null), "equity");
});

test("keeps missing real financial evidence unavailable even when the source path is integrated", () => {
  const aShare = buildFinancialCoverage("a_share", []);
  assert.equal(aShare.status, "unavailable");
  assert.ok(aShare.statements.every((item) => item.status === "unavailable"));

  const hShare = buildFinancialCoverage("h_share", []);
  assert.equal(hShare.status, "unavailable");
  assert.ok(hShare.statements.every((item) => item.status === "unavailable"));

  const usShare = buildFinancialCoverage("us_share", []);
  assert.equal(usShare.policy.localAccess, "configured_proxy_required");
  assert.equal(usShare.status, "unavailable");
});

test("reports partial coverage without allowing one statement to hide missing statements", () => {
  const coverage = buildFinancialCoverage("a_share", [{
    observationId: "obs-income",
    statementType: "income",
    provider: "eastmoney",
    sourceRole: "primary_structured",
    status: "verified_available",
    asOf: 1,
    latestPeriod: "2026Q1",
    reportingCurrency: "CNY",
    accountingBasis: "PRC_GAAP",
    sourceUrl: null,
    blockingReason: null,
    details: {},
  }]);
  assert.equal(coverage.status, "partially_available");
  assert.equal(coverage.statements[0].status, "verified_available");
  assert.equal(coverage.statements[1].status, "unavailable");
  assert.equal(coverage.statements[2].status, "unavailable");
});

test("presents cockpit financial gaps in Chinese without hiding the source requirement", () => {
  const coverage = buildFinancialCoverage("a_share", [{
    observationId: "obs-balance", statementType: "balance", provider: "eastmoney", sourceRole: "primary_structured",
    status: "partially_available", asOf: 1, latestPeriod: "2026Q1", reportingCurrency: "CNY", accountingBasis: "CAS",
    sourceUrl: null, blockingReason: "CNINFO verification is still missing: diluted_shares", details: {},
  }]);
  assert.ok(coverage.gaps.includes("资产负债表：CNINFO 法定核验仍缺：期末稀释股数"));
});

test("security rights mappings require declared official, https evidence instead of name-based linkage", () => {
  assert.deepEqual(validateSecurityRightsEvidence({
    evidenceKind: "official_exchange_disclosure",
    sourceUrl: "https://www1.hkexnews.hk/listedco/listconews/sehk/2025/0328/2025032800598.pdf",
    sourceTitle: "HKEX filing",
    sourceNote: "Identifies the issuer and H-share disclosure.",
  }), {
    evidenceKind: "official_exchange_disclosure",
    sourceUrl: "https://www1.hkexnews.hk/listedco/listconews/sehk/2025/0328/2025032800598.pdf",
    sourceTitle: "HKEX filing",
    sourceNote: "Identifies the issuer and H-share disclosure.",
  });
  assert.throws(() => validateSecurityRightsEvidence({
    evidenceKind: "official_exchange_disclosure",
    sourceUrl: "https://example.com/a-h-mapping",
    sourceTitle: "Ticker names match",
    sourceNote: "This must never be enough.",
  }), /official filing, exchange, or depositary host/);
  assert.throws(() => validateSecurityRightsEvidence({
    evidenceKind: "securities_regulator_filing",
    sourceUrl: "http://www.sec.gov/Archives/example.htm",
    sourceTitle: "SEC filing",
    sourceNote: "HTTPS is mandatory.",
  }), /https/);
});

test("an inbound A/H rights link renders the selected security and its actual counterparty", () => {
  const stored = { securityCode: "00390.HK", relatedSecurityCode: "601390.SH", relationshipKind: "same_operating_company_different_security" };
  assert.deepEqual(normalizeSecurityRightsLinkForSelectedSecurity(stored, "601390.SH"), {
    ...stored,
    securityCode: "601390.SH",
    relatedSecurityCode: "00390.HK",
    relationshipDirection: "to_selected_security",
  });
  assert.deepEqual(normalizeSecurityRightsLinkForSelectedSecurity(stored, "00390.HK"), {
    ...stored,
    relationshipDirection: "from_selected_security",
  });
});
