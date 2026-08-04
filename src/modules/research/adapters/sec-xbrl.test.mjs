import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchSecXbrlDisclosure,
  loadSecRegistrantXbrl,
  collectSecXbrlDisclosure,
} from "./sec-xbrl.ts";

const primaryFact = {
  id: "yahoo:MU.US:income:2025-11-27:revenue",
  metric: "revenue",
  value: 8_050_000_000,
  period: { kind: "quarter", startDate: "2025-08-29", endDate: "2025-11-27", fiscalYear: 2025, fiscalQuarter: 4 },
  basis: { id: "USD:US_GAAP:consolidated:reported", currency: "USD", accountingStandard: "US_GAAP", scope: "consolidated", revision: "reported" },
  provenance: { sourceId: "yahoo:MU.US:income:2025-11-27", sourceType: "yahoo", locator: "totalOperateIncome" },
};

function secPayloads() {
  return {
    "https://www.sec.gov/files/company_tickers.json": {
      "0": { ticker: "MU", cik_str: 723125, title: "MICRON TECHNOLOGY INC" },
    },
    "https://data.sec.gov/api/xbrl/companyfacts/CIK0000723125.json": {
      cik: 723125,
      entityName: "MICRON TECHNOLOGY INC",
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            units: {
              USD: [{
                start: "2025-08-29", end: "2025-11-27", val: 8_050_000_000,
                accn: "0000723125-26-000012", form: "10-Q", filed: "2025-12-19", fy: 2026, fp: "Q1",
              }],
            },
          },
        },
      },
    },
    "https://data.sec.gov/submissions/CIK0000723125.json": {
      filings: { recent: {
        accessionNumber: ["0000723125-26-000012"],
        primaryDocument: ["mu-20251127.htm"],
        filingDate: ["2025-12-19"],
        reportDate: ["2025-11-27"],
        form: ["10-Q"],
      } },
    },
  };
}

function cacheDb() {
  const cache = new Map();
  return {
    prepare(sql) {
      return {
        bind(...values) {
          if (sql.includes("from http_cache")) {
            return { first: async () => cache.get(values[0]) ?? null };
          }
          if (sql.includes("insert into http_cache")) {
            return { run: async () => {
              cache.set(values[0], { status: values[3], headersJson: values[4], bodyText: values[5], expiresAt: values[6], updatedAt: values[7] });
              return { success: true };
            } };
          }
          throw new Error(`Unexpected D1 statement: ${sql}`);
        },
      };
    },
  };
}

async function withSecFetch(fn) {
  const original = globalThis.fetch;
  const payloads = secPayloads();
  globalThis.fetch = async (url) => {
    const body = payloads[String(url)];
    if (!body) throw new Error(`Unexpected SEC request: ${url}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("SEC XBRL resolves MU, selects the exact quarterly duration fact, and preserves a filing pointer", async () => {
  const db = cacheDb();
  const collection = await withSecFetch(() => fetchSecXbrlDisclosure(db, "MU.US", primaryFact));
  assert.equal(collection.provider, "sec");
  assert.equal(collection.reasonCodes.length, 0);
  assert.equal(collection.disclosure?.value, 8_050_000_000);
  assert.equal(collection.disclosure?.documentId, "0000723125-26-000012");
  assert.match(collection.disclosure?.disclosureUrl ?? "", /Archives\/edgar\/data\/723125\/000072312526000012\/mu-20251127\.htm$/);
  assert.match(collection.disclosure?.locator ?? "", /RevenueFromContractWithCustomerExcludingAssessedTax/);
  assert.equal(collection.disclosure?.basis.currency, "USD");
  assert.equal(collection.disclosure?.basis.accountingStandard, "US_GAAP");
});

test("SEC XBRL leaves an unavailable period explicit and never changes registry or data provider", async () => {
  const db = cacheDb();
  const registrant = await withSecFetch(() => loadSecRegistrantXbrl(db, "MU.US"));
  const collection = collectSecXbrlDisclosure(registrant, { ...primaryFact, period: { ...primaryFact.period, endDate: "2026-02-26" } });
  assert.equal(collection.disclosure, null);
  assert.deepEqual(collection.reasonCodes, ["sec_xbrl_period_not_available"]);
  assert.equal(collection.provider, "sec");
});

test("SEC basic outstanding-share DEI fact never verifies a diluted-share input", async () => {
  const db = cacheDb();
  const registrant = await withSecFetch(() => loadSecRegistrantXbrl(db, "MU.US"));
  registrant.companyFacts.facts.dei = {
    EntityCommonStockSharesOutstanding: { units: { shares: [{
      end: "2025-11-27", val: 1_000_000, accn: "0000723125-26-000012", form: "10-Q", filed: "2025-12-19", fy: 2026, fp: "Q1",
    }] } },
  };
  const collection = collectSecXbrlDisclosure(registrant, { ...primaryFact, metric: "diluted_shares" });
  assert.equal(collection.disclosure, null);
  assert.deepEqual(collection.reasonCodes, ["sec_xbrl_diluted_share_concept_not_safe"]);
});

test("accepted human period equivalence can verify a non-calendar Yahoo period without changing the Yahoo fact", () => {
  const nonCalendarFact = {
    ...primaryFact, id: "yahoo:NVDA.US:income:2025-04-30:3M:revenue", canonicalComparisonKey: "comparison:nvda:2025-04-30:revenue",
    value: 44_062_000_000, period: { kind: "quarter", startDate: "2025-02-01", endDate: "2025-04-30", fiscalYear: 2025, fiscalQuarter: 2 },
  };
  const registrant = {
    securityCode: "NVDA.US", ticker: "NVDA", cik: "0001045810", entityName: "NVIDIA CORP",
    companyFacts: { facts: { "us-gaap": { RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [{ start: "2025-01-27", end: "2025-04-27", val: 44_062_000_000, accn: "0001045810-25-000102", form: "10-Q", filed: "2025-05-28" }] } } } } },
    filingsByAccession: new Map([["0001045810-25-000102", { accessionNumber: "0001045810-25-000102", primaryDocument: "nvda-20250427.htm", filingDate: "2025-05-28", reportDate: "2025-04-27", form: "10-Q" }]]),
  };
  const mapping = {
    periodEquivalenceId: "nvda-q1-2026-reported-calendar-date", securityCode: "NVDA.US", primaryComparisonKey: nonCalendarFact.canonicalComparisonKey,
    primaryStatementType: "income", metric: "revenue", primaryPeriod: nonCalendarFact.period, primaryCurrency: "USD",
    secCik: "0001045810", secAccession: "0001045810-25-000102", secNamespace: "us-gaap", secConcept: "RevenueFromContractWithCustomerExcludingAssessedTax", secUnit: "USD",
    secPeriodStartDate: "2025-01-27", secPeriodEndDate: "2025-04-27", secForm: "10-Q", evidenceUrl: "https://www.sec.gov/Archives/edgar/data/1045810/000104581025000102/nvda-20250427.htm", evidenceTitle: "NVIDIA 10-Q",
    reviewDecision: "accepted", reviewReason: "Yahoo calendar display date is tied to this exact SEC 10-Q period.", reviewedBy: "local-user", reviewedAt: 1, createdAt: 1,
  };
  const withoutMapping = collectSecXbrlDisclosure(registrant, nonCalendarFact);
  assert.equal(withoutMapping.disclosure, null);
  assert.deepEqual(withoutMapping.reasonCodes, ["sec_xbrl_period_not_available"]);
  const mapped = collectSecXbrlDisclosure(registrant, nonCalendarFact, { periodEquivalences: [mapping] });
  assert.equal(mapped.disclosure?.value, 44_062_000_000);
  assert.equal(mapped.disclosure?.metadata.periodEquivalenceId, mapping.periodEquivalenceId);
  assert.equal(mapped.disclosure?.metadata.yahooPrimaryPeriod.endDate, "2025-04-30");
});

test("accepted mapping with a different SEC filing cannot become a nearest-date match", () => {
  const fact = { ...primaryFact, canonicalComparisonKey: "comparison:strict", period: { kind: "quarter", startDate: "2025-02-01", endDate: "2025-04-30", fiscalYear: 2025, fiscalQuarter: 2 } };
  const registrant = {
    securityCode: "MU.US", ticker: "MU", cik: "0000723125", entityName: "MICRON", companyFacts: { facts: { "us-gaap": { RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [{ start: "2025-01-27", end: "2025-04-27", val: 8_050_000_000, accn: "0000723125-25-000001", form: "10-Q", filed: "2025-05-01" }] } } } } },
    filingsByAccession: new Map([["0000723125-25-000001", { accessionNumber: "0000723125-25-000001", primaryDocument: "mu.htm", filingDate: "2025-05-01", reportDate: "2025-04-27", form: "10-Q" }]]),
  };
  const mapping = { periodEquivalenceId: "wrong-filing", securityCode: "MU.US", primaryComparisonKey: "comparison:strict", primaryStatementType: "income", metric: "revenue", primaryPeriod: fact.period, primaryCurrency: "USD", secCik: "0000723125", secAccession: "0000723125-25-999999", secNamespace: "us-gaap", secConcept: "RevenueFromContractWithCustomerExcludingAssessedTax", secUnit: "USD", secPeriodStartDate: "2025-01-27", secPeriodEndDate: "2025-04-27", secForm: "10-Q", evidenceUrl: "https://www.sec.gov/Archives/edgar/data/723125/000072312525999999/mu.htm", evidenceTitle: "wrong", reviewDecision: "accepted", reviewReason: "must fail", reviewedBy: "local-user", reviewedAt: 1, createdAt: 1 };
  const result = collectSecXbrlDisclosure(registrant, fact, { periodEquivalences: [mapping] });
  assert.equal(result.disclosure, null);
  assert.deepEqual(result.reasonCodes, ["sec_period_equivalence_mapping_does_not_match_filing"]);
});

test("SEC XBRL rejects a non-US security before any source request", async () => {
  await assert.rejects(() => fetchSecXbrlDisclosure(cacheDb(), "00700.HK", primaryFact), /only supports US securities/i);
});
