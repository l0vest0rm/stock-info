import assert from "node:assert/strict";
import test from "node:test";

import { cachedFetchJson, externalHttpOptions, shouldUseProxy } from "./http.ts";

function emptyCacheDb() {
  return {
    prepare(sql) {
      return {
        bind() {
          if (sql.includes("from http_cache")) return { first: async () => null };
          if (sql.includes("insert into http_cache")) return { run: async () => ({ success: true }) };
          throw new Error(`Unexpected D1 statement: ${sql}`);
        },
      };
    },
  };
}

async function withFetchSpy(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("configured yahoo.com proxy includes finance subdomains and excludes lookalikes", () => {
  const localOptions = externalHttpOptions({
    HTTP_PROXY_URL: "http://127.0.0.1:7890",
    HTTP_PROXY_RELAY_URL: "http://127.0.0.1:7890/fetch",
    HTTP_PROXY_DOMAINS: "yahoo.com",
  });

  assert.equal(shouldUseProxy("https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/AAPL", localOptions), true);
  assert.equal(shouldUseProxy("https://query2.finance.yahoo.com/v7/finance/options/AAPL", localOptions), true);
  assert.equal(shouldUseProxy("https://finance.yahoo.com/quote/AAPL/", localOptions), true);
  assert.equal(shouldUseProxy("https://yahoo.com.evil.example/", localOptions), false);
  assert.equal(shouldUseProxy("https://datacenter.eastmoney.com/", localOptions), false);
});

test("empty production proxy configuration keeps Yahoo direct", () => {
  const productionOptions = externalHttpOptions({
    HTTP_PROXY_URL: "",
    HTTP_PROXY_DOMAINS: "",
  });

  assert.equal(shouldUseProxy("https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/AAPL", productionOptions), false);
});

test("local Yahoo financial request is sent to the configured relay, while non-Yahoo stays direct", async () => {
  const localOptions = externalHttpOptions({
    HTTP_PROXY_URL: "http://127.0.0.1:7890",
    HTTP_PROXY_RELAY_URL: "http://127.0.0.1:7890/fetch",
    HTTP_PROXY_DOMAINS: "yahoo.com",
  });
  const calls = [];
  await withFetchSpy(async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ result: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  }, async () => {
    const yahooUrl = "https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/ORCL?type=quarterlyTotalRevenue";
    assert.deepEqual(await cachedFetchJson(emptyCacheDb(), yahooUrl, { headers: { Accept: "application/json" } }, 60_000, localOptions), { result: "ok" });
    assert.equal(calls[0].url, "http://127.0.0.1:7890/fetch");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
      url: yahooUrl,
      method: "GET",
      headers: { Accept: "application/json" },
    });

    const eastmoneyUrl = "https://datacenter.eastmoney.com/securities/api/data/v1/get";
    assert.deepEqual(await cachedFetchJson(emptyCacheDb(), eastmoneyUrl, undefined, 60_000, localOptions), { result: "ok" });
    assert.equal(calls[1].url, eastmoneyUrl);
  });
});

test("production Yahoo financial request remains direct even when it uses the shared HTTP client", async () => {
  const productionOptions = externalHttpOptions({ HTTP_PROXY_URL: "", HTTP_PROXY_DOMAINS: "" });
  const calls = [];
  await withFetchSpy(async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ result: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  }, async () => {
    const yahooUrl = "https://query2.finance.yahoo.com/v7/finance/options/ORCL";
    assert.deepEqual(await cachedFetchJson(emptyCacheDb(), yahooUrl, undefined, 60_000, productionOptions), { result: "ok" });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://query2.finance.yahoo.com/v7/finance/options/ORCL");
});
