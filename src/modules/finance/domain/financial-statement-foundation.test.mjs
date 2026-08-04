import assert from "node:assert/strict";
import test from "node:test";

import { resolveFinancialStatementSource } from "./financial-statement-source.ts";
import { normalizeFinancialStatement } from "./normalize-financial-statements.ts";
import { loadFinancialStatements } from "../application/load-financial-statements.ts";

test("routes financial statements by market without provider fallback", () => {
  assert.deepEqual(resolveFinancialStatementSource("600519"), {
    code: "600519.SH",
    provider: "eastmoney",
    availability: "available",
    statutoryVerificationSource: "issuer periodic report and exchange/CNINFO disclosure",
    reason: null,
  });
  assert.equal(resolveFinancialStatementSource("NVDA.US").provider, "yahoo");

  const hongKong = resolveFinancialStatementSource("00700.HK");
  assert.equal(hongKong.provider, "eastmoney");
  assert.equal(hongKong.availability, "source_unavailable");
  assert.match(hongKong.reason ?? "", /Yahoo fallback is disabled/);
});

test("normalizes only disclosed source fields and preserves their provenance", () => {
  const normalized = normalizeFinancialStatement({
    code: "NVDA.US",
    statementType: "income",
    reportDate: "2026-04-26",
    fiscalPeriod: "3M",
    payload: {
      NOTICE_DATE: "2026-05-28T00:00:00.000Z",
      totalOperateIncome: 44_062_000_000,
      netProfit: 18_775_000_000,
      basicEps: 0.77,
      ignoredString: "not a numeric statement value",
    },
    source: "yahoo",
    rawR2Key: null,
    updatedAt: 1_770_000_000_000,
  });

  assert.equal(normalized.noticeDate, "2026-05-28");
  assert.deepEqual(normalized.values, [
    { metric: "revenue", value: 44_062_000_000, sourceField: "totalOperateIncome" },
    { metric: "netIncome", value: 18_775_000_000, sourceField: "netProfit" },
    { metric: "basicEps", value: 0.77, sourceField: "basicEps" },
  ]);
  assert.equal(normalized.values.some((item) => item.metric === "grossProfit"), false);
});

test("loads U.S. statements from Yahoo through the shared HTTP path", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      timeseries: {
        result: [
          {
            meta: { type: ["quarterlyTotalRevenue"] },
            quarterlyTotalRevenue: [{ asOfDate: "2026-04-26", reportedValue: { raw: 44_062_000_000 } }],
          },
          {
            meta: { type: ["quarterlyNetIncome"] },
            quarterlyNetIncome: [{ asOfDate: "2026-04-26", reportedValue: { raw: 18_775_000_000 } }],
          },
        ],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const db = {
    prepare() {
      return {
        bind() {
          return {
            first: async () => null,
            run: async () => ({}),
          };
        },
      };
    },
  };
  const bucket = {
    get: async () => null,
    put: async () => undefined,
  };
  try {
    const result = await loadFinancialStatements({ DB: db, MARKET_DATA_BUCKET: bucket }, "NVDA.US", "income");
    assert.equal(result.provider, "yahoo");
    assert.equal(result.source, "yahoo");
    assert.equal(result.rows.length, 1);
    assert.match(requestedUrl, /query1\.finance\.yahoo\.com/);
    assert.match(requestedUrl, /quarterlyTotalRevenue/);
    assert.doesNotMatch(requestedUrl, /quarterlyTotalAssets/);
    assert.deepEqual(result.normalizedRows[0].values, [
      { metric: "revenue", value: 44_062_000_000, sourceField: "totalOperateIncome" },
      { metric: "netIncome", value: 18_775_000_000, sourceField: "netProfit" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
