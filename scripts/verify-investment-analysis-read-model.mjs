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
const tabIds = ["fundamentals", "market", "industry", "forecast", "risk"];

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
  const workspace = await api(`/api/research/company/${encodeURIComponent(code)}`);
  const data = workspace.data;
  assert(data?.identity?.operatingCompany?.companyId, `${code}: operating company is absent`);
  assert(data?.identity?.listedSecurity?.code === code, `${code}: current security identity leaks or is absent`);
  assert(["provisional", "confirmed"].includes(data.identity.listedSecurity.mappingStatus), `${code}: mapping status is not explicit`);
  assert(Array.isArray(data?.researchDepth?.levels) && data.researchDepth.levels.some((item) => item.depth === "standard"), `${code}: standard research state is absent`);
  assert(Array.isArray(data?.dataRequirementCoverage?.requirements), `${code}: requirement coverage is absent`);
  for (const tabId of tabIds) {
    for (const requirementId of requirementsFor(tabId)) {
      const requirement = data.dataRequirementCoverage.requirements.find((item) => item.requirementId === requirementId);
      assert(requirement && ["available", "partial", "missing", "stale", "conflict", "source_error"].includes(requirement.status), `${code}: ${tabId}/${requirementId} status is absent`);
      assert(requirement.missingImpact && requirement.nextEvidence, `${code}: ${tabId}/${requirementId} does not disclose its impact or next automatic input`);
    }
  }
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
  const inputs = data.autoFilingFactInputs;
  assert(inputs?.availability === "available" && Array.isArray(inputs.items) && inputs.items.length === insights.data.items.length, `${code}: filing facts were not materialized as research inputs`);
  for (const input of inputs.items) {
    assert(input.documentUrl && input.evidenceQuote && input.evidenceLocator && input.reportPeriod, `${code}: materialized input lacks source, quote, locator, or period`);
    assert(input.usagePolicy === "source_bound_evidence_only_no_valuation", `${code}: filing input can be mistaken for a valuation assumption`);
    assert(["operating", "market", "governance", "industry", "forecast", "risk"].includes(input.targetModule), `${code}: filing input target module is invalid`);
    assert(input.reportedValue !== "[object Object]", `${code}: materialized input contains an object value`);
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

function requirementsFor(tabId) {
  if (tabId === "fundamentals") return ["business_model_and_drivers", "formal_financial_statements", "statutory_financial_cross_check", "governance_and_capital_allocation"];
  if (tabId === "market" || tabId === "industry") return ["industry_market_kpi_and_peers"];
  if (tabId === "forecast") return ["source_forecasts_and_guidance"];
  return ["thesis_risk_and_review"];
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
