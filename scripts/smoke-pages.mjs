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
  "company-report-predict.html",
  "company-option.html",
];

const failures = [];
let passed = 0;

await check("health", async () => {
  const body = await fetchApi("/api/health");
  assert(body.code === 200, `unexpected api code: ${body.code}`);
});

await check("situation pages and API schemas", async () => {
  const pages = [
    ["situation.html", "situation-today-vue-root", "js/situation-today-page.js"],
    ["situation-holdings.html", "situation-holdings-vue-root", "js/situation-holdings-page.js"],
    ["situation-opportunities.html", "situation-opportunities-vue-root", "js/situation-opportunities-page.js"],
    ["situation-evidence.html", "situation-evidence-vue-root", "js/situation-evidence-page.js"],
  ];
  for (const [pageName, rootId, bundle] of pages) {
    const page = await fetchWithTimeout(`${baseUrl}/${pageName}`);
    const html = await page.text();
    assert(page.status < 400, `${pageName} status=${page.status}`);
    assert(html.includes(rootId), `${pageName} root is missing`);
    assert(html.includes(bundle), `${pageName} bundle is missing`);
  }

  const today = await fetchApi("/api/situations/today");
  assert(today.data && typeof today.data === "object", "situation today payload is missing");
  const status = await fetchApi("/api/situations/status");
  assert(status.data && typeof status.data === "object", "situation status payload is missing");
  for (const endpoint of ["markets", "industries", "holdings?codes=600519.SH", "opportunities"]) {
    const body = await fetchApi(`/api/situations/${endpoint}`);
    assert(body.data && typeof body.data === "object", `situation ${endpoint} payload is missing`);
  }
});

await check("macro page and dashboard schema", async () => {
  const page = await fetchWithTimeout(`${baseUrl}/macro.html`);
  const html = await page.text();
  assert(page.status < 400, `macro page status=${page.status}`);
  assert(html.includes("macro-vue-root"), "macro page root is missing");
  assert(html.includes("js/macro-page.js"), "macro page bundle is missing");

  const body = await fetchApi("/api/macro/dashboard?regions=us,cn,hk,kr");
  assert(Array.isArray(body.data?.indicators), "macro indicators are not an array");
  assert(body.data.indicators.length >= 10, "macro indicator catalog is incomplete");
  assert(typeof body.data?.status?.state === "string", "macro source status is missing");
  assert(
    body.data.indicators.every((item) => item.id && item.name && ["fresh", "stale", "missing"].includes(item.quality)),
    "macro indicators contain invalid quality metadata"
  );
});

await check("macro research, vintage, watch and source-health APIs", async () => {
  const series = await fetchApi("/api/macro/series?ids=SOFR&from=2024-01-01&transform=zscore&window=20");
  assert(Array.isArray(series.data) && Array.isArray(series.data[0]?.points), "macro transformed series is invalid");
  assert(series.data[0]?.transform === "zscore", "macro transform was not applied");

  const revisions = await fetchApi("/api/macro/revisions?id=SOFR&from=2024-01-01");
  assert(Array.isArray(revisions.data?.observations), "macro revisions are not an array");

  const signals = await fetchApi("/api/macro/signals");
  assert(Array.isArray(signals.data?.markets), "macro market signals are not an array");
  assert(typeof signals.data?.methodology === "string", "macro signal methodology is missing");

  const scenario = await fetchApi("/api/macro/research/scenario?ids=SOFR&from=2024-01-01&to=2026-07-30&asOf=2026-07-30T23%3A59%3A59Z");
  assert(Array.isArray(scenario.data?.results), "macro scenario results are not an array");

  const correlation = await fetchApi("/api/macro/research/correlation?seriesId=SOFR&market=cn&from=2026-01-01&to=2026-07-30&window=20");
  assert(correlation.data?.benchmark === "000300.SH", "macro correlation benchmark is incorrect");
  assert(Array.isArray(correlation.data?.points), "macro correlation points are not an array");

  const industries = await fetchApi("/api/macro/research/industries?markets=us,cn,hk,kr");
  assert(Array.isArray(industries.data?.sectors) && industries.data.sectors.length >= 8, "macro industry sensitivity coverage is incomplete");
  assert(industries.data.sectors.every((item) => item.coverage?.configured > 0), "macro industry sensitivity metadata is invalid");

  const backtest = await fetchApi("/api/macro/research/backtest?seriesId=SOFR&market=cn&from=2026-01-01&to=2026-07-30&window=20&horizon=20");
  assert(backtest.data?.vintagePolicy === "initial-release-only", "macro backtest vintage policy is unsafe");
  assert(Array.isArray(backtest.data?.trades), "macro backtest trades are not an array");
  const retrospective = await fetchApi("/api/macro/research/backtest?seriesId=SOFR&market=cn&from=2024-01-01&to=2026-07-30&window=20&horizon=20&vintageMode=retrospective");
  assert(retrospective.data?.vintagePolicy === "retrospective-latest-revision", "macro retrospective backtest mode is missing");
  assert(retrospective.data?.lookAheadSafe === false, "macro retrospective backtest must disclose look-ahead risk");

  await fetchApi("/api/macro/watch", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ownerKey: "smoke-macro", seriesId: "SOFR", enabled: true, alertRules: [{ operator: "gte", threshold: -999 }] }),
  });
  const watches = await fetchApi("/api/macro/watch?owner=smoke-macro");
  assert(watches.data?.some((item) => item.seriesId === "SOFR" && item.enabled), "macro watch was not persisted");
  const alerts = await fetchApi("/api/macro/alerts/evaluate?owner=smoke-macro");
  assert(Array.isArray(alerts.data?.triggered), "macro alerts result is invalid");

  const status = await fetchApi("/api/macro/status");
  assert(Array.isArray(status.data?.sources), "macro source health is not an array");
  assert(status.data.sources.every((item) => ["healthy", "degraded", "failed", "disabled"].includes(item.state)), "macro source health contains an invalid state");
});

await check("company report counts", async () => {
  const body = await fetchApi("/api/companies/report/cnt?days=90");
  const entries = Object.entries(body.data || {});
  assert(entries.length > 0, "company report counts are empty");
  assert(
    entries.every(([code, count]) => /^[A-Z0-9]+\.[A-Z]+$/.test(code) && Number.isInteger(count) && count > 0),
    `company report counts contain invalid entries: ${truncate(JSON.stringify(entries.slice(0, 5)))}`
  );
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
  await check(`eastmoney cookie regression ${stock.code} api kline`, async () => {
    const body = await fetchApi(`/api/kline?code=${encodeURIComponent(stock.code)}&fq=normal`);
    assert(Array.isArray(body.data), "kline data is not an array");
    assert(
      body.data.length >= stock.minKlineRows,
      `${stock.name} kline rows ${body.data.length} < ${stock.minKlineRows}`
    );
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
