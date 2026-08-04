import assert from "node:assert/strict";
import test from "node:test";

import { recordFinancialStatutoryVerification } from "./financial-statutory-verification.ts";

const basis = { id: "usd-us-gaap-consolidated-reported", currency: "USD", accountingStandard: "US_GAAP", scope: "consolidated", revision: "reported" };

test("persists an immutable statutory verification observation with both fact and filing references", async () => {
  let statement = null;
  let bound = null;
  const db = {
    prepare(sql) {
      statement = sql;
      return {
        bind(...values) {
          bound = values;
          return { run: async () => ({ success: true }) };
        },
      };
    },
  };
  const result = await recordFinancialStatutoryVerification(db, {
    verificationId: "verify-sec-revenue-2025-v1",
    securityCode: "NVDA.US",
    createdAt: 1771545600001,
    observedAt: 1771545600000,
    normalizedFact: {
      id: "yahoo:NVDA.US:income:2025-12-31:revenue", metric: "revenue", value: 100,
      canonicalComparisonKey: "financial-comparison:v1:yahoo:NVDA.US:income:2025-01-01:2025-12-31:revenue:usd-us-gaap-consolidated-reported",
      period: { kind: "annual", startDate: "2025-01-01", endDate: "2025-12-31", fiscalYear: 2025 },
      basis, provenance: { sourceId: "yahoo:income:2025", sourceType: "yahoo", locator: "totalRevenue" },
    },
    statutoryDisclosure: {
      provider: "sec", documentId: "0001045810-26-000012", disclosureUrl: "https://www.sec.gov/Archives/edgar/data/1045810/filing.htm",
      locator: "us-gaap:Revenue", publishedAt: "2026-02-20", reportDate: "2025-12-31", value: 100, basis,
    },
  });
  assert.equal(result.outcome, "match");
  assert.match(statement, /insert into research_financial_statutory_verifications/i);
  assert.equal(bound.includes("verify-sec-revenue-2025-v1"), true);
  assert.equal(bound.includes("0001045810-26-000012"), true);
  assert.equal(bound.includes("us-gaap:Revenue"), true);
  assert.equal(bound.length, 44);
});
