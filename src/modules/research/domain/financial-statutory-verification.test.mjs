import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateFinancialStatutoryVerification,
  statutoryVerificationProviderForSecurity,
} from "./financial-statutory-verification.ts";

const basis = {
  id: "usd-us-gaap-consolidated-reported",
  currency: "USD",
  accountingStandard: "US_GAAP",
  scope: "consolidated",
  revision: "reported",
};

function fact(value = 100, overrides = {}) {
  return {
    id: "yahoo:NVDA.US:income:2025-12-31:revenue",
    canonicalComparisonKey: "financial-comparison:v1:yahoo:NVDA.US:income:2025-01-01:2025-12-31:revenue:usd-us-gaap-consolidated-reported",
    metric: "revenue",
    period: { kind: "annual", startDate: "2025-01-01", endDate: "2025-12-31", fiscalYear: 2025 },
    value,
    basis,
    provenance: { sourceId: "yahoo:income:2025", sourceType: "yahoo", locator: "totalRevenue" },
    ...overrides,
  };
}

function disclosure(overrides = {}) {
  return {
    provider: "sec",
    documentId: "0001045810-26-000012",
    disclosureUrl: "https://www.sec.gov/Archives/edgar/data/1045810/filing.htm",
    locator: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax@FY2025",
    publishedAt: "2026-02-20",
    reportDate: "2025-12-31",
    value: 100,
    basis,
    ...overrides,
  };
}

test("uses the one statutory registry selected by market policy", () => {
  assert.equal(statutoryVerificationProviderForSecurity("300308.SZ"), "cninfo");
  assert.equal(statutoryVerificationProviderForSecurity("00700.HK"), "hkex");
  assert.equal(statutoryVerificationProviderForSecurity("NVDA.US"), "sec");
});

test("records a reproducible SEC match with field-level provenance", () => {
  const result = evaluateFinancialStatutoryVerification({
    securityCode: "NVDA.US", normalizedFact: fact(), statutoryDisclosure: disclosure(), observedAt: 1771545600000,
  });
  assert.equal(result.outcome, "match");
  assert.equal(result.provider, "sec");
  assert.equal(result.statutoryDisclosure.documentId, "0001045810-26-000012");
  assert.equal(result.statutoryDisclosure.locator.includes("Revenue"), true);
  assert.equal(result.absoluteDelta, 0);
  assert.deepEqual(result.reasonCodes, []);
});

test("marks an HKEX value conflict rather than averaging competing values", () => {
  const hkdBasis = { ...basis, id: "hkd-ifrs-consolidated-reported", currency: "HKD", accountingStandard: "IFRS" };
  const result = evaluateFinancialStatutoryVerification({
    securityCode: "00700.HK",
    normalizedFact: fact(100, { id: "eastmoney:00700.HK:revenue", basis: hkdBasis }),
    statutoryDisclosure: disclosure({ provider: "hkex", value: 106, basis: hkdBasis, documentId: "HKEX-2025-AR" }),
    observedAt: 1771545600000,
  });
  assert.equal(result.outcome, "conflict");
  assert.equal(result.absoluteDelta, 6);
  assert.deepEqual(result.reasonCodes, ["statutory_value_outside_tolerance"]);
});

test("recognizes audited Eastmoney Chinese aliases for an HKEX RMB IFRS field", () => {
  const result = evaluateFinancialStatutoryVerification({
    securityCode: "00700.HK",
    normalizedFact: fact(196_458_000_000, {
      id: "eastmoney:00700.HK:revenue:2026q1",
      basis: { id: "人民币:国际会计准则:consolidated:reported", currency: "人民币", accountingStandard: "国际会计准则", scope: "consolidated", revision: "reported" },
    }),
    statutoryDisclosure: disclosure({
      provider: "hkex", documentId: "12157226", value: 196_458_000_000,
      basis: { id: "CNY:IFRS:consolidated:reported", currency: "CNY", accountingStandard: "IFRS", scope: "consolidated", revision: "reported" },
    }),
    observedAt: 1771545600000,
  });
  assert.equal(result.outcome, "match");
  assert.deepEqual(result.reasonCodes, []);
});

test("keeps unavailable statutory extraction explicitly unverified", () => {
  const result = evaluateFinancialStatutoryVerification({
    securityCode: "NVDA.US", normalizedFact: fact(),
    statutoryDisclosure: disclosure({ value: null }), observedAt: 1771545600000,
  });
  assert.equal(result.outcome, "unverified");
  assert.deepEqual(result.reasonCodes, ["statutory_field_value_missing"]);
  assert.equal(result.absoluteDelta, null);
});

test("preserves the selected registry's collection reason beside the comparison blocker", () => {
  const result = evaluateFinancialStatutoryVerification({
    securityCode: "300308.SZ",
    normalizedFact: fact(100, { id: "eastmoney:300308.SZ:income:2025-12-31:revenue", provenance: { sourceId: "eastmoney:income:2025", sourceType: "eastmoney" } }),
    statutoryDisclosure: null,
    statutoryCollectionReasonCodes: ["statutory_metric_mapping_not_configured"],
    observedAt: 1771545600000,
  });
  assert.equal(result.outcome, "unverified");
  assert.deepEqual(result.reasonCodes, ["statutory_disclosure_not_collected", "statutory_metric_mapping_not_configured"]);
});

test("does not label an incomplete filing pointer as a conflict", () => {
  const result = evaluateFinancialStatutoryVerification({
    securityCode: "NVDA.US", normalizedFact: fact(),
    statutoryDisclosure: disclosure({ disclosureUrl: null, value: 101 }), observedAt: 1771545600000,
  });
  assert.equal(result.outcome, "unverified");
  assert.deepEqual(result.reasonCodes, ["statutory_disclosure_locator_incomplete"]);
});

test("rejects a provider that would bypass the market statutory policy", () => {
  assert.throws(() => evaluateFinancialStatutoryVerification({
    securityCode: "NVDA.US", normalizedFact: fact(),
    statutoryDisclosure: disclosure({ provider: "hkex" }), observedAt: 1771545600000,
  }), /violates us_share policy/i);
});
