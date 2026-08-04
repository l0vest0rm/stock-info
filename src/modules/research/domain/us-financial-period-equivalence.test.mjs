import assert from "node:assert/strict";
import test from "node:test";

import { acceptedUsFinancialPeriodEquivalenceForFact, assertUsFinancialPeriodEquivalence } from "./us-financial-period-equivalence.ts";

function mapping(overrides = {}) {
  return { periodEquivalenceId: "period:1", securityCode: "NVDA.US", primaryComparisonKey: "comparison:1", primaryStatementType: "income", metric: "revenue", primaryPeriod: { kind: "quarter", startDate: "2025-02-01", endDate: "2025-04-30", fiscalYear: 2025, fiscalQuarter: 2 }, primaryCurrency: "USD", secCik: "0001045810", secAccession: "0001045810-25-000102", secNamespace: "us-gaap", secConcept: "RevenueFromContractWithCustomerExcludingAssessedTax", secUnit: "USD", secPeriodStartDate: "2025-01-27", secPeriodEndDate: "2025-04-27", secForm: "10-Q", evidenceUrl: "https://www.sec.gov/Archives/edgar/data/1045810/000104581025000102/nvda.htm", evidenceTitle: "NVIDIA 10-Q", reviewDecision: "accepted", reviewReason: "reviewed", reviewedBy: "local-user", reviewedAt: 1, createdAt: 1, ...overrides };
}
function fact(overrides = {}) { return { id: "yahoo:NVDA.US:income:2025-04-30:3M:0:revenue", canonicalComparisonKey: "comparison:1", metric: "revenue", value: 1, period: { kind: "quarter", startDate: "2025-02-01", endDate: "2025-04-30", fiscalYear: 2025, fiscalQuarter: 2 }, basis: { id: "USD:US_GAAP:consolidated:reported", currency: "USD", accountingStandard: "US_GAAP", scope: "consolidated", revision: "reported" }, provenance: { sourceId: "yahoo:NVDA.US:income:2025-04-30:3M:0", sourceType: "yahoo", locator: "revenue" }, ...overrides }; }

test("period equivalence requires a frozen SEC filing locator and accepted mapping matches only the exact Yahoo fact", () => {
  assert.doesNotThrow(() => assertUsFinancialPeriodEquivalence(mapping()));
  assert.throws(() => assertUsFinancialPeriodEquivalence(mapping({ evidenceUrl: "https://example.com/filing" })), /SEC filing archive/);
  assert.equal(acceptedUsFinancialPeriodEquivalenceForFact([mapping()], fact())?.periodEquivalenceId, "period:1");
  assert.equal(acceptedUsFinancialPeriodEquivalenceForFact([mapping()], fact({ canonicalComparisonKey: "other" })), null);
  assert.equal(acceptedUsFinancialPeriodEquivalenceForFact([mapping(), mapping({ periodEquivalenceId: "period:2" })], fact()), null);
});
