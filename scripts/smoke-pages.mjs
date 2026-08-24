#!/usr/bin/env node

const baseUrl = normalizeBaseUrl(process.env.SMOKE_BASE_URL || "http://127.0.0.1:8000");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || "30000");

const stocks = [
  { market: "sz-a", code: "300750.SZ", name: "宁德时代", minKlineRows: 100 },
  { market: "sh-a", code: "600519.SH", name: "贵州茅台", minKlineRows: 100 },
  { market: "hk", code: "00700.HK", name: "腾讯控股", minKlineRows: 100 },
  { market: "us", code: "MU.US", name: "美光科技", minKlineRows: 100 },
];

const klineRegressions = [
  { code: "600487.SH", name: "亨通光电", minKlineRows: 100 },
  { code: "002156.SZ", name: "通富微电", minKlineRows: 100 },
];

const stockPages = [
  "company.html",
  "company-trade.html",
  "company-finance.html",
  "company-holders.html",
  "company-dividend.html",
  "company-shares.html",
  "company-notice.html",
  "company-report.html",
  "company-news.html",
  "company-option.html",
];

const failures = [];
let passed = 0;

await check("health", async () => {
  const body = await fetchApi("/api/health");
  assert(body.code === 200, `unexpected api code: ${body.code}`);
});

await check("retired situation surfaces", async () => {
  for (const path of [
    "/situation.html",
    "/situation-holdings.html",
    "/situation-opportunities.html",
    "/situation-evidence.html",
    "/api/situations/today",
    "/api/situations/status",
  ]) {
    const response = await fetchWithTimeout(`${baseUrl}${path}`);
    assert(response.status === 404, `${path} status=${response.status}`);
  }
});

await check("institutional tracks page", async () => {
  const page = await fetchWithTimeout(`${baseUrl}/institutional-tracks.html`);
  const html = await page.text();
  assert(page.status < 400, `institutional tracks page status=${page.status}`);
  assert(html.includes("institutional-tracks-vue-root"), "institutional tracks root is missing");
  assert(html.includes("js/institutional-tracks-page.js"), "institutional tracks bundle is missing");
});

await check("macro catalog directory and generic overview", async () => {
  const page = await fetchWithTimeout(`${baseUrl}/macro.html`);
  const html = await page.text();
  assert(page.status < 400, `macro page status=${page.status}`);
  assert(html.includes("macro-vue-root"), "macro page root is missing");
  assert(html.includes("js/macro-page.js"), "macro page bundle is missing");

  const body = await fetchApi("/api/macro/catalog");
  assert(Array.isArray(body.data?.regions), "macro regions are not an array");
  assert(Array.isArray(body.data?.categories), "macro categories are not an array");
  assert(Array.isArray(body.data?.metrics), "macro metrics are not an array");
  assert(Array.isArray(body.data?.series), "macro concrete series are not an array");
  assert(
    body.data.series.every((item) => Number.isInteger(item.id) && item.region?.code && item.category?.code && item.metric?.name && item.measures?.yoy && item.measures?.mom),
    "macro series directory contains incomplete metadata"
  );
  assert(body.data.capabilities && Array.isArray(body.data.capabilities.frequencies), "macro catalog capabilities are missing");

  const region = body.data.regions[0]?.code;
  const overview = await fetchApi(`/api/macro/overview${region ? `?regions=${encodeURIComponent(region)}` : ""}`);
  assert(Array.isArray(overview.data?.series), "macro overview series are not an array");
  assert(
    overview.data.series.every((item) => item.definition?.id && item.yoy?.status && item.mom?.status && item.freshness?.status && item.availability?.status && item.trend?.status),
    "macro overview does not expose the card contract"
  );
  if (region) assert(overview.data.series.every((item) => item.definition.regionCode === region), "macro overview ignores the selected region");
});

await check("macro windowed series and retired API removal", async () => {
  const catalog = await fetchApi("/api/macro/catalog");
  const region = catalog.data?.regions?.[0]?.code;
  const overview = await fetchApi(`/api/macro/overview${region ? `?regions=${encodeURIComponent(region)}` : ""}`);
  const current = overview.data?.series?.find((item) => item.current?.period);
  if (current) {
    const series = await fetchApi(`/api/macro/series?ids=${current.definition.id}&measure=level&from=${current.current.period}&to=${current.current.period}`);
    assert(Array.isArray(series.data?.series) && series.data.series.length === 1, "macro windowed series response is invalid");
    assert(series.data.series[0].measure === "level" && Array.isArray(series.data.series[0].points), "macro series measure contract is invalid");
  }
  for (const path of ["/api/macro/dashboard", "/api/macro/events", "/api/macro/status", "/api/macro/signals", "/api/macro/watch", "/api/macro/alerts/history", "/api/macro/provenance", "/api/macro/research/backtest"]) {
    const response = await fetchWithTimeout(`${baseUrl}${path}`);
    assert(response.status === 404, `${path} status=${response.status}; retired macro endpoint is still available`);
  }
});

await check("published research pages", async () => {
  const pages = [
    ["fund-compare.html", "fund-compare-vue-root", "js/fund-compare-page.js"],
  ];
  for (const [pageName, rootId, bundle] of pages) {
    const response = await fetchWithTimeout(`${baseUrl}/${pageName}`);
    const html = await response.text();
    assert(response.status < 400, `${pageName} status=${response.status}`);
    assert(html.includes(rootId), `${pageName} root is missing`);
    assert(html.includes(bundle), `${pageName} bundle is missing`);
  }
  const removedIndustryPage = await fetchWithTimeout(`${baseUrl}/industry-research.html`);
  assert(removedIndustryPage.status === 404, `removed industry research page status=${removedIndustryPage.status}`);
  const removedIndustryApi = await fetchWithTimeout(`${baseUrl}/api/research/industry?industry=${encodeURIComponent("通信设备")}`);
  assert(removedIndustryApi.status === 404, `removed industry research API status=${removedIndustryApi.status}`);
  const funds = await fetchApi("/api/fund/compare?codes=513100.OF,510300.OF");
  assert(Array.isArray(funds.data?.rows) && funds.data.rows.length === 2, "fund comparison rows are incomplete");
});

await check("fund search 易方达蓝筹精选混合", async () => {
  const body = await fetchApi(`/api/search?q=${encodeURIComponent("易方达蓝筹精选混合")}`);
  assert(
    body.data?.some((item) => item.code === "005827.OF" && item.type === "fund"),
    `fund 005827.OF missing from search results: ${truncate(JSON.stringify(body.data))}`
  );
});

await check("fund 005827.OF page fund-notice.html", async () => {
  const res = await fetchWithTimeout(pageUrl("fund-notice.html", "005827.OF"));
  const text = await res.text();
  assert(res.status < 400, `status=${res.status} body=${truncate(text)}`);
  assert(text.includes("fund-notice-vue-root"), "fund notice page root is missing");
});

await check("fund 005827.OF page fund-position.html", async () => {
  const res = await fetchWithTimeout(pageUrl("fund-position.html", "005827.OF"));
  const text = await res.text();
  assert(res.status < 400, `status=${res.status} body=${truncate(text)}`);
  assert(text.includes("fund-position-vue-root"), "fund position page root is missing");
});

await check("fund 008528.OF paginated kline range", async () => {
  const body = await fetchApi("/api/kline?code=008528.OF&from=2026-01-01&to=2026-07-24");
  assert(Array.isArray(body.data), "fund kline data is not an array");
  assert(body.data.length > 20, `fund kline pagination stopped early: rows=${body.data.length}`);
  assert(body.data[0][0] >= Date.parse("2026-01-01T00:00:00.000Z"), "fund kline starts before requested range");
  assert(body.data.at(-1)[0] <= Date.parse("2026-07-24T00:00:00.000Z"), "fund kline ends after requested range");
});

await check("fund 005827.OF api asset allocation", async () => {
  const body = await fetchApi("/api/fund/asset-allocation?code=005827.OF");
  assert(Array.isArray(body.data?.rows), "fund asset allocation rows is not an array");
  assert(body.data.rows.length >= 2, "fund asset allocation history is incomplete");
  const latest = body.data.rows[0];
  assert(/^\d{4}-\d{2}-\d{2}$/.test(latest.reportDate), "fund asset allocation date is invalid");
  assert(typeof latest.stockPct === "number", "fund stock allocation is not numeric");
  assert(typeof latest.cashPct === "number", "fund cash allocation is not numeric");
  assert(typeof latest.netAssetsBillion === "number", "fund net assets is not numeric");
});

await check("fund 005827.OF api notices", async () => {
  const body = await fetchApi("/api/fund/notices?code=005827.OF&page=1&pageSize=5&category=0");
  assert(Array.isArray(body.data?.rows), "fund notices rows is not an array");
  assert(body.data.rows.length > 0, "fund notices rows are empty");
  assert(body.data.rows.every((item) => item.id && item.title && item.publishDate), "fund notice fields are incomplete");
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

for (const stock of klineRegressions) {
  await check(`xueqiu cookie regression ${stock.code} api kline`, async () => {
    const body = await fetchApi(`/api/kline?code=${encodeURIComponent(stock.code)}&fq=normal`);
    assert(Array.isArray(body.data), "kline data is not an array");
    assert(
      body.data.length >= stock.minKlineRows,
      `${stock.name} kline rows ${body.data.length} < ${stock.minKlineRows}`
    );
  });
}

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

async function fetchApi(path, init) {
  const res = await fetchWithTimeout(`${baseUrl}${path}`, init);
  const text = await res.text();
  assert(res.status < 400, `status=${res.status} body=${truncate(text)}`);
  const body = JSON.parse(text);
  assert(body.code === 200, `api code=${body.code} msg=${body.msg}`);
  return body;
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init.headers);
    if (!headers.has("User-Agent")) headers.set("User-Agent", "stock-info-smoke/0.1");
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers,
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
