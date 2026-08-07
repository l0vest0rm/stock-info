import assert from "node:assert/strict";
import test from "node:test";

import { fetchYahooFinance } from "./eastmoney.ts";
import { fetchEastmoneyHongKongFinance } from "./eastmoney.ts";

function cacheDb() {
  const cache = new Map();
  return {
    prepare(sql) {
      return {
        bind(...values) {
          if (sql.includes("from http_cache")) return { first: async () => cache.get(values[0]) ?? null };
          if (sql.includes("insert into http_cache")) return { run: async () => {
            cache.set(values[0], { status: values[3], headersJson: values[4], bodyText: values[5], expiresAt: values[6], updatedAt: values[7] });
            return { success: true };
          } };
          throw new Error(`Unexpected D1 statement: ${sql}`);
        },
      };
    },
  };
}

async function withYahooFetch(payload, fn) {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    return await fn(urls);
  } finally {
    globalThis.fetch = original;
  }
}

test("Yahoo financial adapter preserves source currency and separates 3M from 12M at one end date", async () => {
  const payload = { timeseries: { result: [
    { meta: { type: ["quarterlyTotalRevenue"] }, quarterlyTotalRevenue: [{ asOfDate: "2026-03-31", periodType: "3M", currencyCode: "CNY", dataId: "quarterlyRevenue", reportedValue: { raw: 247_652_000_000 } }] },
    { meta: { type: ["annualTotalRevenue"] }, annualTotalRevenue: [{ asOfDate: "2026-03-31", periodType: "12M", currencyCode: "CNY", dataId: "annualRevenue", reportedValue: { raw: 1_023_670_000_000 } }] },
  ] } };
  await withYahooFetch(payload, async (urls) => {
    const rows = await fetchYahooFinance(cacheDb(), "BABA.US", "income");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.fiscalPeriod).sort(), ["12M", "3M"]);
    assert.ok(rows.every((row) => row.payload.REPORTING_CURRENCY === "CNY"));
    assert.ok(rows.every((row) => row.payload.FINANCIAL_SOURCE_CONTRACT === "yahoo_finance_timeseries.v3"));
    assert.equal(rows[0].payload.TOTAL_OPERATE_INCOME, 247_652_000_000);
    assert.equal(rows[0].payload.FINANCIAL_FIELD_ORIGINS.TOTAL_OPERATE_INCOME, "quarterlyTotalRevenue");
    assert.match(urls[0], /quarterlyTotalRevenue/);
    assert.match(urls[0], /annualTotalRevenue/);
  });
});

test("Yahoo financial adapter makes a field-currency conflict explicit instead of selecting a trading-currency fallback", async () => {
  const payload = { timeseries: { result: [
    { meta: { type: ["quarterlyTotalRevenue"] }, quarterlyTotalRevenue: [{ asOfDate: "2026-03-31", periodType: "3M", currencyCode: "CNY", reportedValue: { raw: 1 } }] },
    { meta: { type: ["quarterlyNetIncome"] }, quarterlyNetIncome: [{ asOfDate: "2026-03-31", periodType: "3M", currencyCode: "USD", reportedValue: { raw: 2 } }] },
  ] } };
  await withYahooFetch(payload, async () => {
    const [row] = await fetchYahooFinance(cacheDb(), "BABA.US", "income");
    assert.equal(row.payload.YAHOO_CURRENCY_CONFLICT, true);
    assert.equal(row.payload.REPORTING_CURRENCY, undefined);
  });
});

test("Hong Kong F10 fields are losslessly mapped into the shared financial contract", async () => {
  await withYahooFetch({ result: { data: [] } }, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      const body = url.includes("RPT_HKF10_FN_MAININDICATOR")
        ? { result: { data: [{ REPORT_DATE: "2025-12-31", REPORT_TYPE: "2025年年报", OPERATE_INCOME: 751_766_000_000, HOLDER_PROFIT: 224_842_000_000, GROSS_PROFIT: 422_593_000_000, END_CASH: 141_041_000_000, NETCASH_OPERATE: 303_052_000_000 }] } }
        : { result: { data: [{ REPORT_LIST: [{ REPORT_DATE: "2025-12-31", REPORT_TYPE: "年报", CURRENCY: "人民币", ACCOUNT_STANDARD: "国际会计准则" }] }] } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const [row] = await fetchEastmoneyHongKongFinance(cacheDb(), "00700.HK", "income");
      assert.equal(row.fiscalPeriod, "年报");
      assert.equal(row.payload.FINANCIAL_SOURCE_CONTRACT, "eastmoney_hk_f10_main_indicator.v2");
      assert.equal(row.payload.TOTAL_OPERATE_INCOME, 751_766_000_000);
      assert.equal(row.payload.PARENT_NETPROFIT, 224_842_000_000);
      assert.equal(row.payload.END_CCE, 141_041_000_000);
      assert.deepEqual(row.payload.FINANCIAL_FIELD_ORIGINS, {
        TOTAL_OPERATE_INCOME: "OPERATE_INCOME",
        PARENT_NETPROFIT: "HOLDER_PROFIT",
        END_CCE: "END_CASH",
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
