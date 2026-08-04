import assert from "node:assert/strict";
import test from "node:test";

import { produceSecStatutoryVerifications } from "./sec-statutory-verification.ts";

const fact = {
  id: "yahoo:MU.US:income:2025-11-27:revenue",
  canonicalComparisonKey: "financial-comparison:v1:yahoo:MU.US:income:2025-08-29:2025-11-27:revenue:USD-US_GAAP-consolidated-reported",
  metric: "revenue",
  value: 8_050_000_000,
  period: { kind: "quarter", startDate: "2025-08-29", endDate: "2025-11-27", fiscalYear: 2025, fiscalQuarter: 4 },
  basis: { id: "USD:US_GAAP:consolidated:reported", currency: "USD", accountingStandard: "US_GAAP", scope: "consolidated", revision: "reported" },
  provenance: { sourceId: "yahoo:MU.US:income:2025-11-27", sourceType: "yahoo", locator: "totalOperateIncome" },
};

function dbWithObservationSink() {
  const cache = new Map();
  const recorded = [];
  return {
    recorded,
    prepare(sql) {
      return {
        bind(...values) {
          if (sql.includes("from http_cache")) return { first: async () => cache.get(values[0]) ?? null };
          if (sql.includes("insert into http_cache")) return { run: async () => {
            cache.set(values[0], { status: values[3], headersJson: values[4], bodyText: values[5], expiresAt: values[6], updatedAt: values[7] });
            return { success: true };
          } };
          if (sql.includes("insert into research_financial_statutory_verifications")) return { run: async () => {
            recorded.push(values);
            return { success: true };
          } };
          throw new Error(`Unexpected D1 statement: ${sql}`);
        },
      };
    },
  };
}

test("SEC producer appends an auditable verification and preserves Yahoo as only primary provenance", async () => {
  const db = dbWithObservationSink();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const value = String(url);
    const payload = value.includes("company_tickers")
      ? { "0": { ticker: "MU", cik_str: 723125, title: "MICRON TECHNOLOGY INC" } }
      : value.includes("companyfacts")
        ? {
          facts: {
            "us-gaap": {
              RevenueFromContractWithCustomerExcludingAssessedTax: {
                units: {
                  USD: [{ start: "2025-08-29", end: "2025-11-27", val: 8_050_000_000, accn: "0000723125-26-000012", form: "10-Q", filed: "2025-12-19" }],
                },
              },
            },
          },
        }
        : { filings: { recent: { accessionNumber: ["0000723125-26-000012"], primaryDocument: ["mu-20251127.htm"], filingDate: ["2025-12-19"], reportDate: ["2025-11-27"], form: ["10-Q"] } } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await produceSecStatutoryVerifications({ DB: db }, {
      securityCode: "MU.US",
      normalizedFacts: [fact],
      observedAt: 1_771_545_600_000,
      createdAt: 1_771_545_600_001,
      verificationIdForFact: () => "sec-mu-revenue-2025-v1",
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].verification.outcome, "match");
    assert.equal(result[0].verification.normalizedFact.provenance.sourceType, "yahoo");
    assert.equal(result[0].verification.statutoryDisclosure?.provider, "sec");
    assert.equal(db.recorded.length, 1);
    assert.equal(db.recorded[0].includes("sec-mu-revenue-2025-v1"), true);
  } finally {
    globalThis.fetch = original;
  }
});
