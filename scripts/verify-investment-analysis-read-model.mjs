#!/usr/bin/env node

const baseUrl = String(process.env.INVESTMENT_ANALYSIS_BASE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const timeoutMs = Number(process.env.INVESTMENT_ANALYSIS_TIMEOUT_MS || "30000");

// The samples deliberately span A shares, Hong Kong shares and U.S. shares.
// The expected result is truthful partial coverage, not an invented "ready"
// valuation state.
const samples = [
  { code: "300308.SZ", market: "A" },
  { code: "600519.SH", market: "A" },
  { code: "601088.SH", market: "A" },
  { code: "00700.HK", market: "HK" },
  { code: "AAPL.US", market: "US" },
];
await verifyPageShell();
for (const sample of samples) await verifySample(sample);
console.log(`investment-analysis read-model verification passed for ${samples.length} real cross-market samples.`);

async function verifyPageShell() {
  const html = await text(`/investment-analysis.html?code=600519.SH`);
  assert(html.includes("investment-analysis-vue-root"), "investment-analysis root is missing");
  assert(html.includes("js/investment-analysis-page.js"), "investment-analysis bundle is missing");
  const bundle = await text("/js/investment-analysis-page.js");
  for (const label of ["完整投资研究", "报告目录", "investment-analysis", "research:investment-analysis", "ia-heading-"]) {
    assert(bundle.includes(label), `investment-analysis bundle is missing ${label}`);
  }
  assert(!bundle.includes("investment-review"), "investment-analysis bundle still calls the retired second-stage review API");
  assert(!bundle.includes("两轮问答"), "investment-analysis bundle still describes the retired two-stage workflow");
  assert(!bundle.includes("S0-S12处理进度"), "investment-analysis bundle still exposes retired stage progress");
  assert(!bundle.includes("operating-analysis-low-dependency"), "investment-analysis bundle still calls the retired low-dependency workflow");
}

async function verifySample({ code, market }) {
  const insights = await api(`/api/research/company/${encodeURIComponent(code)}/auto-filing-insights`);
  assert(Array.isArray(insights.data?.items) && insights.data.items.length > 0, `${code}: no stored filing facts`);
  const seenTabs = new Set(insights.data.items.map((item) => item.tabId));
  for (const tabId of ["business", "market", "financial", "industry", "risk"]) assert(seenTabs.has(tabId), `${code}: ${tabId} filing facts are absent`);
  for (const item of insights.data.items) {
    assert(item.documentUrl && item.evidenceQuote && item.evidenceLocator && item.reportPeriod, `${code}: a filing fact lacks source, quote, locator, or period`);
    assert(String(item.extractionMethod || "").includes("research-filing-extraction.v3"), `${code}: filing fact has an obsolete processing method`);
    assert(item.factType && item.valueType, `${code}: filing fact has no typed extraction facet`);
    assert(item.reportedValue !== "[object Object]", `${code}: invalid object value is rendered as a fact`);
  }
  const overview = await api(`/api/company/overview?code=${encodeURIComponent(code)}`);
  assert(overview.data?.source === "xueqiu", `${code}: ${market} market price did not retain Xueqiu provenance`);
  const investmentAnalysis = await api(`/api/research/company/${encodeURIComponent(code)}/investment-analysis`);
  assert(["available", "empty", "pending", "failed"].includes(investmentAnalysis.data?.availability), `${code}: investment-analysis availability is absent`);
  if (investmentAnalysis.data?.task) assert.equal(investmentAnalysis.data.task.name, `research:investment-analysis:${code}`, `${code}: taskd name is not the caller business identity`);
  if (investmentAnalysis.data?.report?.markdown) {
    assert(investmentAnalysis.data.report.markdown.length >= 800, `${code}: report is shorter than the business contract`);
    const headings = new Set([...investmentAnalysis.data.report.markdown.matchAll(/^# ([1-9]|1[0-2])\. /gm)].map((match) => match[1]));
    assert.equal(headings.size, 12, `${code}: report lacks the twelve H1 headings`);
  }
}

async function api(path) {
  const response = await request(path);
  const body = await response.json().catch(() => null);
  assert(response.ok && body?.code === 200, `${path}: ${body?.msg || response.status}`);
  return body;
}

async function text(path) {
  const response = await request(path);
  assert(response.ok, `${path}: ${response.status}`);
  return response.text();
}

async function request(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(`${baseUrl}${path}`, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function assert(condition, message) { if (!condition) throw new Error(message); }
