#!/usr/bin/env node

const baseUrl = normalizeBaseUrl(process.env.SMOKE_BASE_URL || "http://127.0.0.1:8000");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || "30000");

const stocks = [
  { market: "sz-a", code: "300750.SZ", name: "宁德时代", minKlineRows: 100 },
  { market: "sh-a", code: "600519.SH", name: "贵州茅台", minKlineRows: 100 },
  { market: "hk", code: "00700.HK", name: "腾讯控股", minKlineRows: 100 },
  { market: "us", code: "MU.US", name: "美光科技", minKlineRows: 100 },
];

const stockPages = [
  "company.html",
  "company-finance.html",
  "company-holders.html",
  "company-dividend.html",
  "company-shares.html",
  "company-notice.html",
  "company-report.html",
  "company-news.html",
  "company-report-predict.html",
  "company-option.html",
];

const failures = [];
let passed = 0;

await check("health", async () => {
  const body = await fetchApi("/api/health");
  assert(body.code === 200, `unexpected api code: ${body.code}`);
});

for (const stock of stocks) {
  for (const page of stockPages) {
    await check(`${stock.market} ${stock.code} page ${page}`, async () => {
      const url = pageUrl(page, stock.code);
      const res = await fetchWithTimeout(url);
      const text = await res.text();
      assert(res.status < 400, `status=${res.status} body=${truncate(text)}`);
      assert(text.includes("<html") || text.includes("<!doctype"), "response is not html");
      assert(!text.includes("Internal Server Error"), "page contains Internal Server Error");
    });
  }

  await check(`${stock.market} ${stock.code} api kline`, async () => {
    const body = await fetchApi(`/api/kline?code=${encodeURIComponent(stock.code)}&fq=normal`);
    assert(Array.isArray(body.data), "kline data is not an array");
    assert(
      body.data.length >= stock.minKlineRows,
      `kline rows ${body.data.length} < ${stock.minKlineRows}`
    );
  });

  await check(`${stock.market} ${stock.code} api company overview`, async () => {
    const body = await fetchApi(`/api/company/overview?code=${encodeURIComponent(stock.code)}`);
    assert(body.data?.code === stock.code, `overview code mismatch: ${body.data?.code}`);
    assert(typeof body.data?.name === "string" && body.data.name.length > 0, "overview name is empty");
    assert(typeof body.data?.latestPrice === "number", "overview latestPrice is not numeric");
  });

  await check(`${stock.market} ${stock.code} api company info`, async () => {
    const body = await fetchApi(`/api/company/info?code=${encodeURIComponent(stock.code)}`);
    assert(body.data?.code === stock.code, `company info code mismatch: ${body.data?.code}`);
  });

  await check(`${stock.market} ${stock.code} api finance income`, async () => {
    const body = await fetchApi(`/api/finance/income?code=${encodeURIComponent(stock.code)}`);
    assert(Array.isArray(body.data), "income data is not an array");
  });

  await check(`${stock.market} ${stock.code} api sharechange`, async () => {
    const body = await fetchApi(`/api/finance/sharechange?code=${encodeURIComponent(stock.code)}`);
    assert(Array.isArray(body.data), "sharechange data is not an array");
  });

  await check(`${stock.market} ${stock.code} api notices`, async () => {
    const body = await fetchApi(`/api/company/notices?code=${encodeURIComponent(stock.code)}&page=1&pageSize=5`);
    assert(Array.isArray(body.data), "notices data is not an array");
  });
}

await check("us MU.US api options", async () => {
  const body = await fetchApi("/api/options/us?code=MU.US");
  assert(body.data?.code === "MU.US", `option code mismatch: ${body.data?.code}`);
  assert(Array.isArray(body.data?.expirations), "option expirations is not an array");
});

if (failures.length > 0) {
  console.error(`\nSmoke failed: ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) {
    console.error(`- ${failure.name}: ${failure.message}`);
  }
  process.exit(1);
}

console.log(`\nSmoke passed: ${passed} checks`);

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ name, message });
    console.error(`FAIL ${name}: ${message}`);
  }
}

async function fetchApi(path) {
  const res = await fetchWithTimeout(`${baseUrl}${path}`);
  const text = await res.text();
  assert(res.status < 400, `status=${res.status} body=${truncate(text)}`);
  const body = JSON.parse(text);
  assert(body.code === 200, `api code=${body.code} msg=${body.msg}`);
  return body;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "stock-info-smoke/0.1",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function pageUrl(page, code) {
  const url = new URL(`${baseUrl}/${page}`);
  url.searchParams.set("code", code);
  url.searchParams.set("from", "1735689600000");
  return url.toString();
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function truncate(value, max = 300) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
