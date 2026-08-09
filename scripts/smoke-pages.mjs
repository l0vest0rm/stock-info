#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const baseUrl = normalizeBaseUrl(process.env.SMOKE_BASE_URL || "http://127.0.0.1:8000");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || "30000");
const representativeAcceptance = JSON.parse(await readFile(new URL("../config/research-representative-acceptance.v1.json", import.meta.url), "utf8"));

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
  "company-research.html",
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
  const companyResearchBundle = await (await fetchWithTimeout(`${baseUrl}/js/company-research-page.js`)).text();
  assert(companyResearchBundle.includes("data-financial-statement-sources"), "company research does not distinguish financial origin from cache delivery");
  assert(companyResearchBundle.includes("交易币种"), "company research does not expose security trading currency separately from company reporting currency");
  assert(companyResearchBundle.includes("字段化行业与同行工作台"), "company research does not expose the typed industry workflow");
  assert(companyResearchBundle.includes("经营模型、驱动树与市场空间工作台"), "company research does not expose the typed operating-model workflow");
  assert(companyResearchBundle.includes("风险压力、复核与公共快照工作台"), "company research does not expose the risk review workflow");
  assert(companyResearchBundle.includes("来源结果 → 精确复核队列"), "company research does not expose the source-bound formal/event impact review workflow");
  assert(companyResearchBundle.includes("记录最终处置"), "company research does not expose local thesis/risk impact disposition controls");
  assert(companyResearchBundle.includes("原命题或风险及既有快照均未被改写"), "company research does not disclose immutable impact disposition boundary");
  assert(companyResearchBundle.includes("研究深度门禁"), "company research does not expose explicit basic/standard/deep gates");
  assert(companyResearchBundle.includes("行业 KPI → 分部驱动 → 财务传导"), "company research does not expose the source-bound KPI transmission workflow");
  assert(companyResearchBundle.includes("经营披露来源事实账本"), "company research does not expose the immutable operating-source-fact ledger");
  assert(companyResearchBundle.includes("反向估值、敏感性和每股价值须由完整经营模型"), "company research does not disclose the reverse-valuation evidence boundary");
  assert(companyResearchBundle.includes("主估值原型与辅助相对估值工作台"), "company research does not expose the source-bound relative-valuation workbench");
  assert(companyResearchBundle.includes("六项可比性门禁（全部必填）"), "company research does not require all relative-valuation comparability gates");
  assert(companyResearchBundle.includes("data-research-cockpit"), "company research lacks the canonical overview DOM contract");
  assert(companyResearchBundle.includes("data-research-layer-map"), "company research lacks the explicit four-layer navigation map");
  assert(companyResearchBundle.includes("市场与上市结构层"), "company research does not distinguish the current security from the operating company");
  assert(companyResearchBundle.includes("data-research-core-results"), "company research lacks the framework-aligned core results overview");
  assert(companyResearchBundle.includes("data-research-forecast-summary"), "company research routes the forecast reading card only into a hidden workbench");
  assert(companyResearchBundle.includes("research-competition"), "company research lacks a visible industry/competition reading anchor");
  assert(companyResearchBundle.includes("research-market"), "company research lacks a visible market-status reading anchor");
  assert(companyResearchBundle.includes("research-evidence"), "company research lacks a visible source-evidence reading anchor");
  assert(companyResearchBundle.includes("来源预测、来源情景、确定性汇总、校准和估值版本均由已保存输入自动生成或自动阻断"), "company research does not expose the persisted calibration boundary");
  assert(companyResearchBundle.includes("区分已发生、管理层指引和外部预期，并标明影响的假设。"), "company research does not visibly distinguish management guidance from external expectations");
  assert(companyResearchBundle.includes("正式财务覆盖："), "company research does not surface the formal-financial coverage boundary");
  assert(companyResearchBundle.includes("data-statutory-revision-candidate"), "company research does not expose a stable statutory-revision candidate audit contract");
  assert(companyResearchBundle.includes("被修订原始文件 ID"), "company research does not display the reviewed restatement's original filing reference");
  assert(companyResearchBundle.includes("未创建正式实际、校准或估值"), "company research does not explain the 409 restatement-verification no-write boundary");
  assert(companyResearchBundle.includes("本地服务返回非 JSON 响应"), "company research leaks raw parser failures from a statutory-restatement verification response");
  assert(companyResearchBundle.includes("data-research-anchor"), "company research lacks stable research-section DOM anchors");
  assert(companyResearchBundle.includes("data-research-workbench"), "company research does not separate local write workbenches from the reading flow");
  assert(companyResearchBundle.includes('"dossier-records"'), "company research does not place dossier writes in a dedicated collapsed workbench");
  assert(companyResearchBundle.includes('"governance-capital-facts"'), "company research exposes governance-candidate writes outside a dedicated local workbench");
  assert(companyResearchBundle.includes('"statutory-disclosure-index"'), "company research does not isolate statutory-index refresh writes in a local workbench");
  assert(companyResearchBundle.includes('"sec-statutory-verification"'), "company research does not isolate SEC verification writes in a local workbench");
  assert(companyResearchBundle.includes('"company-focus-profile"'), "company research does not mark focus-profile writes as a local workbench");
  assert(!companyResearchBundle.includes('"新增个人笔记"'), "company research still exposes personal-note creation directly in the reading flow");
  assert(companyResearchBundle.includes('"financial-entity-profile"'), "company research does not isolate financial-entity profile writes in a local workbench");
  assert(companyResearchBundle.includes('"financial-specialty-metrics"'), "company research does not isolate financial-specialty fact writes in a local workbench");
  assert(companyResearchBundle.includes("data-us-financial-period-equivalence-workbench"),
    "company research does not expose the local-only Yahoo-to-SEC period-equivalence workbench");
  assert(companyResearchBundle.includes("Yahoo—SEC 非自然财年报告期等价映射"),
    "company research does not label the audited non-calendar Yahoo-to-SEC mapping boundary");
  assert(companyResearchBundle.includes('"public-research-snapshot"'), "company research does not keep public snapshot writes in a dedicated local workbench");
  assert(companyResearchBundle.includes("本地研究工作台：冻结公共研究快照"), "company research does not label the default-collapsed public snapshot write workbench");
  assert(companyResearchBundle.includes("data-public-research-snapshots"), "company research does not retain the visible read-only public snapshot history contract");
  assert(companyResearchBundle.includes("data-owner-holding-snapshot-references"),
    "company research does not expose the private owner-holding to public-snapshot reference boundary");
  assert(companyResearchBundle.includes('"owner-holding-snapshot-references"'),
    "owner holding snapshot writes are not isolated in a default-collapsed local workbench");
  assert(companyResearchBundle.includes("系统行动候选不被当作个人交易计划"),
    "company research does not disclose that system candidates are not a substitute for a user trade-plan model");
  assert(companyResearchBundle.includes("data-research-review-queue"), "company research does not provide the progressive-disclosure review queue contract");
  assert(companyResearchBundle.includes("data-research-review-action"), "company research review queue cannot route an item to its read-only research section");
  assert(companyResearchBundle.includes("本次读取"), "company research labels read time as a false global data cutoff");
  assert(companyResearchBundle.includes("data-research-hero-scope"), "company research hero does not expose the primary-track and valuation-gate state");
  assert(companyResearchBundle.includes("波动率和流动性：当前读模型未接入"), "company research market card overstates unavailable volatility or liquidity coverage");
  assert(companyResearchBundle.includes("上游阻断"), "company research does not make blocked review evidence visible");
  assert(companyResearchBundle.includes("focus-profile"), "company research cannot deep-link a public focus profile");
  assert(!companyResearchBundle.includes("研究工作流"), "company research still renders a duplicate workflow blocker summary");

  const today = await fetchApi("/api/situations/today");
  assert(today.data && typeof today.data === "object", "situation today payload is missing");
  const status = await fetchApi("/api/situations/status");
  assert(status.data && typeof status.data === "object", "situation status payload is missing");
  for (const endpoint of ["markets", "industries", "holdings?codes=600519.SH", "opportunities"]) {
    const body = await fetchApi(`/api/situations/${endpoint}`);
    assert(body.data && typeof body.data === "object", `situation ${endpoint} payload is missing`);
  }
});

await check("institutional tracks page", async () => {
  const page = await fetchWithTimeout(`${baseUrl}/institutional-tracks.html`);
  const html = await page.text();
  assert(page.status < 400, `institutional tracks page status=${page.status}`);
  assert(html.includes("institutional-tracks-vue-root"), "institutional tracks root is missing");
  assert(html.includes("js/institutional-tracks-page.js"), "institutional tracks bundle is missing");
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

  const provenance = await fetchApi("/api/macro/provenance?ids=SOFR");
  assert(provenance.data?.series?.[0]?.configuredSource?.sourceId === "ny-fed", "macro provenance does not expose its configured source");

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
  const alerts = await fetchApi("/api/macro/alerts/evaluate?owner=smoke-macro", { method: "POST" });
  assert(Array.isArray(alerts.data?.triggered), "macro alerts result is invalid");
  assert(alerts.data?.persisted === true, "macro alerts were not persisted");
  const history = await fetchApi("/api/macro/alerts/history?owner=smoke-macro");
  assert(Array.isArray(history.data?.entries), "macro alert history is invalid");
  assert(history.data.entries.some((entry) => entry.seriesId === "SOFR"), "macro alert history did not retain the data vintage");

  const status = await fetchApi("/api/macro/status");
  assert(Array.isArray(status.data?.sources), "macro source health is not an array");
  assert(status.data.sources.every((item) => ["healthy", "degraded", "failed", "disabled"].includes(item.state)), "macro source health contains an invalid state");
});

await check("company report counts", async () => {
  const body = await fetchApi("/api/companies/report/cnt?days=90");
  const entries = Object.entries(body.data || {});
  assert(
    entries.every(([code, count]) => /^[A-Z0-9]+\.[A-Z]+$/.test(code) && Number.isInteger(count) && count > 0),
    `company report counts contain invalid entries: ${truncate(JSON.stringify(entries.slice(0, 5)))}`
  );
});

await check("research workbench pages and API schemas", async () => {
  const pages = [
    ["company-research.html?code=300750.SZ", "company-research-vue-root", "js/company-research-page.js"],
    ["industry-research.html?industry=%E9%80%9A%E4%BF%A1%E8%AE%BE%E5%A4%87", "industry-research-vue-root", "js/industry-research-page.js"],
    ["fund-compare.html", "fund-compare-vue-root", "js/fund-compare-page.js"],
  ];
  for (const [pageName, rootId, bundle] of pages) {
    const response = await fetchWithTimeout(`${baseUrl}/${pageName}`);
    const html = await response.text();
    assert(response.status < 400, `${pageName} status=${response.status}`);
    assert(html.includes(rootId), `${pageName} root is missing`);
    assert(html.includes(bundle), `${pageName} bundle is missing`);
  }
  const company = await fetchApi("/api/research/company/300750.SZ");
  assert(Array.isArray(company.data?.decision?.gates) && company.data.decision.gates.length === 4, "company research gates are incomplete");
  assert(Array.isArray(company.data?.evidence), "company research evidence is invalid");
  assert(Array.isArray(company.data?.riskProfile?.findings) && Array.isArray(company.data?.riskProfile?.gaps), "company risk profile is incomplete");
  assert(typeof company.data?.capabilities?.canWriteLocally === "boolean" && company.data?.capabilities?.productionLlmEnabled === false,
    "company research runtime boundary is incomplete");
  assert(company.data?.identity && company.data?.financials && company.data?.dossier && company.data?.governance,
    "company research identity, financial, dossier, or governance layer is missing");
  assert(typeof company.data?.financials?.availability === "string" && Array.isArray(company.data?.dossier?.risks?.items),
    "company research coverage contract is invalid");
  assert(company.data?.dataRequirementCoverage?.ruleVersion === "research-data-requirements.v1"
    && Array.isArray(company.data.dataRequirementCoverage.requirements)
    && company.data.dataRequirementCoverage.requirements.every((item) => item.primarySources?.length && item.frequency && item.epistemicType && item.missingImpact)
    && Array.isArray(company.data.dataRequirementCoverage.sourceHealth),
  "company research fact requirement/source-health contract is incomplete");
  assert(company.data?.researchDepth?.ruleVersion === "research-depth.v1" && Array.isArray(company.data?.researchDepth?.levels)
    && company.data.researchDepth.levels.map((item) => item.depth).join(",") === "basic,standard,deep",
  "company research depth gates are incomplete");
  const focusProfileSample = await fetchApi("/api/research/company/601390.SH?owner=local-user");
  const focusProfile = focusProfileSample.data?.focusProfile;
  assert(["available", "empty", "unavailable"].includes(focusProfile?.availability), "focus-profile deep-link did not return an explicit availability state");
  if (focusProfile?.availability === "available") {
    assert(focusProfile.profile?.version >= 1 && Array.isArray(focusProfile.profile.items) && focusProfile.profile.items.length > 0,
      "available focus-profile deep-link has no auditable public items");
  }
  assert(["available", "empty", "unavailable"].includes(company.data?.operating?.sourceFacts?.availability)
    && Array.isArray(company.data?.operating?.sourceFacts?.items), "company operating source-fact ledger contract is invalid");
  assert(["available", "empty", "unavailable"].includes(company.data?.reverseValuationModels?.availability)
    && Array.isArray(company.data?.reverseValuationModels?.items), "company reverse valuation version contract is invalid");
  const hongKongResearch = await fetchApi("/api/research/company/00700.HK");
  assert(hongKongResearch.data?.financials?.sourcePolicy === "Eastmoney HK F10 → HKEX 核验（无自动回退）",
    "Hong Kong research finance source policy is invalid");
  assert(hongKongResearch.data?.financials?.statements?.every((item) => item.source !== "yahoo" && item.rows > 0),
    "Hong Kong research must use Eastmoney financial data without Yahoo fallback");
  assert(hongKongResearch.data?.financials?.availability === "partial",
    "Hong Kong financial conclusions must remain partial before HKEX field verification");
  const kpiContext = await fetchApi("/api/research/company/300308.SZ/industry-kpi-driver-binding-context");
  assert(kpiContext.data?.canWriteLocally === true && Array.isArray(kpiContext.data?.rules)
    && Array.isArray(kpiContext.data?.eligibleEvidence) && Array.isArray(kpiContext.data?.driverPlans),
  "industry KPI binding context is incomplete");
  const guidanceEventReviews = await fetchApi("/api/research/company/300308.SZ/guidance-event-impact-reviews");
  assert(Array.isArray(guidanceEventReviews.data?.items), "formal/event impact review ledger is invalid");
  assert(guidanceEventReviews.data.items.every((review) => Array.isArray(review.targets)
    && review.targets.every((target) => typeof target.impactReviewTargetId === "string"
      && ["requires_review", "no_change", "follow_up_recorded", "not_applicable"].includes(target.reviewState))),
  "formal/event impact target state contract is invalid");
  const blockedValuation = await fetchApi("/api/research/company/300308.SZ");
  assert(Array.isArray(blockedValuation.data?.formalActuals) && Array.isArray(blockedValuation.data?.forecastWorkspace?.scenarios), "company research impact-review source/target context is incomplete");
  const blockedValuationCoverage = blockedValuation.data?.coverage?.modules?.find((item) => item.moduleId === "valuation");
  assert(blockedValuation.data?.marketStructure?.perShareValuation?.status === "blocked"
    && blockedValuationCoverage?.status === "blocked"
    && /(精确每股价值|每股结论)/.test(blockedValuationCoverage?.conclusionImpact || ""),
  "current valuation remains blocked without current financial or per-share market-structure gates");
  const formalCandidates = await fetchApi("/api/research/company/00700.HK/formal-actual-candidates?eligibility=ready_for_review");
  assert(Array.isArray(formalCandidates.data?.candidates) && Array.isArray(formalCandidates.data?.reviews)
    && formalCandidates.data.candidates.every((item) => typeof item.metric === "string"
      && typeof item.factDictionaryEntryId === "string" && item.factDictionaryEntryId.startsWith("formal-financial-fact:")),
  "formal actual candidate dictionary contract is invalid");
  for (const code of ["300750.SZ", "300308.SZ", "00700.HK", "MU.US"]) {
    const forecasts = await fetchApi(`/api/research/company/${encodeURIComponent(code)}/forecasts`);
    assert(forecasts.data?.subject?.listedSecurity?.code === code, `forecast subject mismatch: ${code}`);
    assert(Array.isArray(forecasts.data?.sourceCandidates), `forecast candidates are invalid: ${code}`);
    assert(Array.isArray(forecasts.data?.sourceForecasts), `source forecasts are invalid: ${code}`);
    assert(forecasts.data?.managementGuidanceRevisions?.ruleVersion === "management-guidance-revision.v1"
      && Array.isArray(forecasts.data.managementGuidanceRevisions.directions)
      && Array.isArray(forecasts.data.managementGuidanceRevisions.chains),
    `management guidance revision audit model is invalid: ${code}`);
    assert(forecasts.data?.formalActualHealth?.ruleVersion === "formal-actual-health.v1"
      && ["available", "partial", "unavailable"].includes(forecasts.data.formalActualHealth.calibrationAvailability),
    `formal actual health model is invalid: ${code}`);
    assert(forecasts.data.sourceCandidates.every((item) => item.informationId && item.resultId && item.processingRunId
      && item.versionId && item.docId && item.processingModel && item.processingPromptVersion && item.processingInputHash),
    `forecast candidate provenance is incomplete: ${code}`);
    assert(forecasts.data?.capabilities?.productionLlmEnabled === false, `production LLM flag must stay false: ${code}`);
    const visibleForecastLedger = JSON.stringify({
      candidates: forecasts.data?.sourceCandidates,
      samples: forecasts.data?.sourceForecasts,
      revisions: forecasts.data?.forecastRevisions,
      consolidation: forecasts.data?.consolidation,
      synthesisDrafts: forecasts.data?.synthesisDrafts,
    });
    assert(!/fixture-|https?:\/\/(?:[^/]+\.)?example\.com(?:\/|$)/.test(visibleForecastLedger),
      `synthetic or reserved-domain forecast evidence is visible for ${code}`);
    assert(forecasts.data?.consolidation === null || forecasts.data.consolidation.marketConsensus === false, `incomplete forecast sample was called consensus: ${code}`);
    if (forecasts.data?.consolidation) {
      assert(forecasts.data.consolidation.label === "已纳入样本的预测汇总", `forecast consolidation label is unsafe: ${code}`);
      assert(Array.isArray(forecasts.data.consolidation.groups) && Array.isArray(forecasts.data.consolidation.members),
        `forecast consolidation audit members are incomplete: ${code}`);
    }
  }
  const industry = await fetchApi(`/api/research/industry?industry=${encodeURIComponent("通信设备")}`);
  assert(typeof industry.data?.assessment?.state === "string", "industry research assessment is missing");
  const funds = await fetchApi("/api/fund/compare?codes=513100.OF,510300.OF");
  assert(Array.isArray(funds.data?.rows) && funds.data.rows.length === 2, "fund comparison rows are incomplete");
});

await check("frozen representative research acceptance package", async () => {
  if (process.env.SMOKE_REQUIRE_REPRESENTATIVE_ACCEPTANCE !== "1") {
    console.log("SKIP frozen representative research acceptance package: requires a separately provisioned source-bound research fixture");
    return;
  }
  const expectedCategories = ["A/H 同主体", "ADR", "银行", "周期", "未盈利"];
  assert(representativeAcceptance?.version === "research-representative-acceptance.v1", "representative acceptance config version is invalid");
  assert(Array.isArray(representativeAcceptance?.cases) && representativeAcceptance.cases.length === expectedCategories.length,
    "representative acceptance cases are incomplete");
  assert(representativeAcceptance.cases.map((item) => item.category).join(",") === expectedCategories.join(","),
    "representative acceptance categories changed without an explicit review");
  assert(Object.values(representativeAcceptance.sharedAssertions?.prohibitedOutputs || {}).every(Boolean),
    "representative acceptance lacks depth-level prohibited conclusions");

  const pageBundle = await (await fetchWithTimeout(`${baseUrl}/js/company-research-page.js`)).text();
  for (const marker of representativeAcceptance.sharedAssertions.requiredBundleMarkers || []) {
    assert(pageBundle.includes(marker), `company research bundle lacks representative page marker: ${marker}`);
  }
  for (const sampleCase of representativeAcceptance.cases) {
    const records = await Promise.all(sampleCase.securities.map(async (security) => ({
      security,
      page: await fetchWithTimeout(pageUrl("company-research.html", security.code)),
      research: await fetchApi(`/api/research/company/${encodeURIComponent(security.code)}`),
    })));
    const observedBoundaryConclusions = new Set();
    for (const { security, page, research } of records) {
      const pageHtml = await page.text();
      const data = research.data;
      const identity = data?.identity;
      const listedSecurity = identity?.listedSecurity;
      const financials = data?.financials;
      const sourceHealth = new Map((data?.dataRequirementCoverage?.sourceHealth || []).map((item) => [item.sourceId, item.status]));
      const depths = new Map((data?.researchDepth?.levels || []).map((item) => [item.depth, item]));
      assert(page.status < 400, `${sampleCase.label} ${security.code} research page status=${page.status}`);
      for (const marker of representativeAcceptance.sharedAssertions.pageShellMarkers || []) {
        assert(pageHtml.includes(marker), `${sampleCase.label} ${security.code} research page entry lacks ${marker}`);
      }
      assert(listedSecurity?.code === security.code && listedSecurity?.market === security.market,
        `${sampleCase.label} ${security.code} market identity is incorrect`);
      assert(listedSecurity?.instrumentKind === security.instrumentKind && listedSecurity?.mappingStatus === security.mappingStatus,
        `${sampleCase.label} ${security.code} instrument or source-bound mapping status changed`);
      assert(financials?.sourcePolicy === security.financialPolicy && financials?.availability === security.financialAvailability,
        `${sampleCase.label} ${security.code} financial source status changed`);
      assert(identity?.financials?.policy?.noAutomaticFallback === true,
        `${sampleCase.label} ${security.code} unexpectedly permits a financial-source fallback`);
      assert(Array.isArray(financials?.statements) && financials.statements.length === 3
        && financials.statements.every((statement) => Number.isInteger(statement.rows) && statement.rows >= 0),
      `${sampleCase.label} ${security.code} does not expose three statement source states`);
      const expectedPrimaryProvider = security.market === "us_share" ? "yahoo" : "eastmoney";
      assert(financials.statements.every((statement) => Array.isArray(statement.originProviders)
        && statement.originProviders.includes(expectedPrimaryProvider)),
      `${sampleCase.label} ${security.code} hides its financial primary origin behind the delivery cache`);
      for (const [sourceId, expectedStatus] of Object.entries(security.requiredSourceStatus || {})) {
        assert(sourceHealth.get(sourceId) === expectedStatus,
          `${sampleCase.label} ${security.code} ${sourceId} source status=${sourceHealth.get(sourceId)}; expected ${expectedStatus}`);
      }
      assert(data?.researchDepth?.ruleVersion === representativeAcceptance.sharedAssertions.requiredDepthRuleVersion,
        `${sampleCase.label} ${security.code} research depth contract changed`);
      for (const [depthName, expectedStatus] of Object.entries(security.depthStatus || {})) {
        const depth = depths.get(depthName);
        assert(depth?.status === expectedStatus, `${sampleCase.label} ${security.code} ${depthName} depth=${depth?.status}; expected ${expectedStatus}`);
        assert(depth?.prohibitedOutput === representativeAcceptance.sharedAssertions.prohibitedOutputs[depthName],
          `${sampleCase.label} ${security.code} ${depthName} prohibited output changed`);
        for (const requirement of depth?.requirements || []) observedBoundaryConclusions.add(requirement.blockedConclusion);
      }
      for (const requirementId of security.blockedRequirements || []) {
        const requirement = [...depths.values()].flatMap((depth) => depth?.requirements || []).find((item) => item.id === requirementId);
        assert(requirement && requirement.status !== "ready", `${sampleCase.label} ${security.code} missing-evidence requirement ${requirementId} is no longer blocked`);
      }
      if (security.depositaryRatio !== undefined) {
        assert(listedSecurity?.depositaryRatio === security.depositaryRatio,
          `${sampleCase.label} ${security.code} ADR ratio is not source-bound`);
      }
      if (security.mappingStatus === "unresolved") {
        assert(identity?.operatingCompany === null && identity?.relationships?.length === 0
          && identity?.rightsProfiles?.length === 0 && identity?.rightsLinks?.length === 0,
        `${sampleCase.label} ${security.code} fabricated a company or cross-security relationship without a source-bound mapping`);
      }
      if (security.requiresHistoricalLoss) {
        const income = await fetchApi(`/api/finance/income?code=${encodeURIComponent(security.code)}`);
        assert(income.data?.some((row) => typeof row.netProfit === "number" && row.netProfit < 0),
          `${sampleCase.label} ${security.code} no longer demonstrates an unprofitable-company history`);
      }
    }
    if (sampleCase.sharedOperatingCompanyId) {
      assert(records.every(({ research }) => research.data?.identity?.operatingCompany?.companyId === sampleCase.sharedOperatingCompanyId),
        `${sampleCase.label} does not retain its confirmed shared operating company`);
    }
    const allProhibited = new Set([
      ...Object.values(representativeAcceptance.sharedAssertions.prohibitedOutputs || {}),
      ...observedBoundaryConclusions,
    ]);
    for (const conclusion of sampleCase.prohibitedConclusions || []) {
      assert(allProhibited.has(conclusion), `${sampleCase.label} no longer exposes required prohibited conclusion: ${conclusion}`);
    }
  }
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
