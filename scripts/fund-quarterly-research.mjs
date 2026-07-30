#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  SharedLlmClient,
  SQLiteLlmCacheStore,
  createResponsesProvider,
} from "@m2ai/shared-llm-client/sqlite";

import {
  aggregateCurrentFundHoldings,
  aggregateReportForecasts,
  analyzePositionChanges,
  buildHoldingMarketSnapshot,
  buildOutputFilename,
  dedupeFundShareClasses,
  extractManagementDiscussion,
  findFundReportNotice,
  latestQuarterlyReportDate,
  mapNotice,
  normalizePositionPeriods,
  outputAlreadyExists,
  parseFundRankRows,
  parseFundTotalShares,
  previousReportDate,
  quarterId,
  renderPrompt,
  renderFundHoldingsStatisticsHtml,
  renderFundIndexMarkdown,
  returnBetweenKlines,
  selectDisclosedHoldings,
  stripMarkdownFence,
  validateGeneratedReport,
} from "./lib/fund-quarterly-research.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const configPath = resolve(rootDir, options.config);
  const config = await loadConfig(configPath);
  const asOf = options.asOf ?? shanghaiToday();
  const reportDate = options.reportDate ?? latestQuarterlyReportDate(asOf);
  const priorReportDate = previousReportDate(reportDate);
  const reportQuarter = quarterId(reportDate);
  const rankLimit = options.limit ?? config.ranking.topN;
  const baseUrl = String(options.baseUrl ?? config.baseUrl).replace(/\/$/, "");
  const outputDir = resolve(rootDir, options.output ?? config.outputDir);
  const stateDir = resolve(rootDir, config.stateDir);
  const evidenceDir = join(stateDir, "evidence", reportQuarter);
  const promptSystem = await readFile(resolve(rootDir, config.prompts.system), "utf8");
  const promptUserTemplate = await readFile(resolve(rootDir, config.prompts.user), "utf8");
  await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(evidenceDir, { recursive: true })]);

  const rankStartDate = monthsBefore(asOf, 3);
  const rankRows = await fetchTinfo(baseUrl, "/api/fund/rank", {
    ft: config.ranking.fundType,
    sc: "3yzf",
    st: "desc",
    sd: rankStartDate,
    ed: asOf,
    pi: 1,
    pn: rankLimit,
  }, config.sources);
  let candidates = dedupeFundShareClasses(
    parseFundRankRows(rankRows.rows).slice(0, rankLimit),
    config.ranking.shareClassPriority,
  );
  if (options.fundCode) candidates = candidates.filter((fund) => fund.code === options.fundCode);

  log("rank_selected", {
    asOf,
    reportDate,
    rawTopN: Math.min(rankLimit, Array.isArray(rankRows.rows) ? rankRows.rows.length : 0),
    afterShareClassDedupe: candidates.length,
    fundCode: options.fundCode ?? "",
  });

  const discoveries = await mapLimit(candidates, config.sources.noticeConcurrency, async (fund) => {
    const outputPath = join(outputDir, buildOutputFilename(fund.name, fund.code, reportDate));
    if (!options.force && await outputAlreadyExists(outputPath)) {
      return { status: "skipped_existing", fund, outputPath };
    }
    try {
      const notices = (await fetchFundNotices(fund.code, config.sources)).filter((notice) => {
        const publishDate = String(notice.PUBLISHDATEDesc ?? "").slice(0, 10);
        return publishDate && publishDate <= asOf;
      });
      const currentNotice = findFundReportNotice(notices, fund.code, reportDate);
      if (!currentNotice) return { status: "skipped_no_latest_report", fund, outputPath };
      const priorNotice = findFundReportNotice(notices, fund.code, priorReportDate);
      return { status: "eligible", fund, outputPath, notices, currentNotice, priorNotice };
    } catch (error) {
      return { status: "failed_discovery", fund, outputPath, error };
    }
  });

  for (const item of discoveries) {
    if (item.status !== "eligible") {
      log(item.status, { code: item.fund.code, name: item.fund.name, error: errorMessage(item.error) });
    }
  }
  const eligible = discoveries.filter((item) => item.status === "eligible");
  log("latest_report_filter", { eligible: eligible.length, reportDate });

  const llm = options.dryRun || eligible.length === 0 ? null : await createLlmClient(config, stateDir);
  const analysisConcurrency = options.concurrency ?? config.llm.concurrency;
  const results = await mapLimit(eligible, analysisConcurrency, async (item) => {
    try {
      const evidence = await collectFundEvidence({
        item,
        asOf,
        reportDate,
        priorReportDate,
        reportQuarter,
        baseUrl,
        config,
      });
      const evidencePath = join(evidenceDir, `${item.fund.code}-${reportQuarter}.json`);
      await writeJson(evidencePath, evidence);
      if (options.dryRun) {
        log("dry_run_evidence", { code: item.fund.code, evidencePath });
        return { status: "dry_run", fund: item.fund, evidencePath };
      }

      const prompt = renderPrompt(promptUserTemplate, {
        EVIDENCE_PATH: evidencePath,
        OUTPUT_PATH: item.outputPath,
        EVIDENCE_JSON: JSON.stringify(evidence, null, 2),
      });
      const llmResult = await llm.client.generateText({
        provider: llm.provider,
        model: llm.model,
        instructions: promptSystem,
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
        maxOutputTokens: config.llm.maxOutputTokens,
        temperature: config.llm.temperature,
        allowReasoning: true,
        reasoningEffort: config.llm.reasoningEffort,
        cacheTtlMs: config.llm.cacheTtlMs,
      });
      const markdown = validateGeneratedReport(stripMarkdownFence(llmResult.text), item.fund);
      await atomicWrite(item.outputPath, `${markdown}\n`);
      log("written", { code: item.fund.code, outputPath: item.outputPath, llmCached: llmResult.cached });
      return { status: "written", fund: item.fund, outputPath: item.outputPath, evidencePath };
    } catch (error) {
      log("failed_analysis", { code: item.fund.code, name: item.fund.name, error: errorMessage(error) });
      return { status: "failed_analysis", fund: item.fund, error };
    }
  });

  let indexPath = "";
  let holdingsStatisticsPath = "";
  if (!options.dryRun) {
    const index = await updateQuarterIndex({
      asOf,
      reportDate,
      reportQuarter,
      outputDir,
      stateDir,
      candidates,
      discoveries,
      partialRun: Boolean(options.fundCode),
    });
    indexPath = index.indexPath;
    log("index_written", { indexPath });
    const holdingsStatistics = await updateHoldingsStatistics({
      asOf,
      reportDate,
      reportQuarter,
      baseUrl,
      outputDir,
      evidenceDir,
      stateDir,
      funds: index.funds,
      config,
      force: options.force,
    });
    holdingsStatisticsPath = holdingsStatistics.path;
    log(holdingsStatistics.skipped ? "holdings_statistics_skipped" : "holdings_statistics_written", {
      holdingsStatisticsPath,
      holdings: holdingsStatistics.holdings,
    });
  }

  const summary = summarize([...discoveries.filter((item) => item.status !== "eligible"), ...results]);
  log("complete", { ...summary, outputDir, evidenceDir, indexPath, holdingsStatisticsPath, dryRun: options.dryRun });
  if ((summary.failed_discovery ?? 0) + (summary.failed_analysis ?? 0) > 0) process.exitCode = 1;
}

async function updateQuarterIndex({
  asOf,
  reportDate,
  reportQuarter,
  outputDir,
  stateDir,
  candidates,
  discoveries,
  partialRun,
}) {
  const scope = createHash("sha256").update(outputDir).digest("hex").slice(0, 12);
  const indexStatePath = join(stateDir, "indexes", `${reportQuarter}-${scope}.json`);
  const previousState = await readOptionalJson(indexStatePath, { funds: [] });
  const records = new Map((previousState.funds ?? []).map((fund) => [fund.code, fund]));
  if (!partialRun) {
    const currentCodes = new Set(candidates.map((fund) => fund.code));
    for (const code of records.keys()) {
      if (!currentCodes.has(code)) records.delete(code);
    }
  }
  const discoveriesByCode = new Map(discoveries.map((item) => [item.fund.code, item]));
  for (const fund of candidates) {
    const outputPath = join(outputDir, buildOutputFilename(fund.name, fund.code, reportDate));
    if (!await outputAlreadyExists(outputPath)) {
      if (!partialRun) records.delete(fund.code);
      continue;
    }
    const discovery = discoveriesByCode.get(fund.code);
    const previous = records.get(fund.code) ?? {};
    records.set(fund.code, {
      ...previous,
      ...fund,
      outputFilename: basename(outputPath),
      reportPublishDate: String(discovery?.currentNotice?.PUBLISHDATEDesc ?? previous.reportPublishDate ?? "").slice(0, 10),
    });
  }
  const funds = [...records.values()].sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code));
  const state = { schemaVersion: 1, asOf, reportDate, quarter: reportQuarter, outputDir, funds };
  await writeJson(indexStatePath, state);
  const indexPath = join(outputDir, `基金季度分析索引-${reportQuarter}.md`);
  const holdingsStatisticsFilename = `基金持仓统计-${reportQuarter}.html`;
  await atomicWrite(indexPath, `${renderFundIndexMarkdown({
    asOf,
    reportDate,
    quarter: reportQuarter,
    funds,
    holdingsStatisticsFilename,
  })}\n`);
  return { indexPath, funds };
}

async function updateHoldingsStatistics({
  asOf,
  reportDate,
  reportQuarter,
  baseUrl,
  outputDir,
  evidenceDir,
  stateDir,
  funds,
  config,
  force,
}) {
  const settings = config.holdingsStatistics;
  const path = join(outputDir, `基金持仓统计-${reportQuarter}.html`);
  const legacyMarkdownPath = join(outputDir, `基金持仓统计-${reportQuarter}.md`);
  if (settings?.enabled === false) return { path: "", skipped: true, holdings: 0 };

  const evidenceResults = await Promise.all(funds.map(async (fund) => {
    const evidencePath = join(evidenceDir, `${fund.code}-${reportQuarter}.json`);
    const evidence = await readOptionalJson(evidencePath, null);
    return { fund, evidence, evidencePath };
  }));
  const evidences = evidenceResults.flatMap((item) => item.evidence ? [item.evidence] : []);
  const missingEvidence = evidenceResults.filter((item) => !item.evidence);
  const holdings = aggregateCurrentFundHoldings(evidences);
  const signature = createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    asOf,
    reportDate,
    holdings: holdings.map((holding) => [
      holding.code,
      holding.funds.map((fund) => [fund.code, fund.weightPct]),
    ]),
  })).digest("hex");
  const statePath = join(stateDir, "holdings", `${reportQuarter}-${asOf}.json`);
  const previousState = await readOptionalJson(statePath, null);
  const periods = resolvePerformancePeriods(asOf, settings?.performancePeriods ?? []);
  const forecastYears = resolveForecastYears(asOf, settings?.forecastYears);
  if (!force && previousState?.signature === signature && Array.isArray(previousState.holdings)) {
    const html = renderFundHoldingsStatisticsHtml({
      asOf,
      reportDate,
      quarter: reportQuarter,
      fundsAnalyzed: previousState.fundsAnalyzed ?? evidences.length,
      holdings: previousState.holdings,
      periods,
      forecastYears,
      baseUrl,
      warnings: previousState.warnings ?? [],
    });
    await atomicWrite(path, `${html}\n`);
    await rm(legacyMarkdownPath, { force: true });
    return { path, skipped: true, holdings: previousState.holdings.length };
  }

  const earliestStart = periods.map((period) => period.startDate).sort()[0] ?? daysBefore(asOf, 365);
  const klineStart = daysBefore(earliestStart, 7);
  const marketRows = await fetchHoldingMarkets(baseUrl, holdings.map((holding) => holding.code), settings, config.sources);
  const markets = new Map(marketRows.map((row) => [normalizeSecurityCode(row.SECUCODE ?? row.SECURITY_CODE), row]));
  const warnings = missingEvidence.map((item) => `${item.fund.name}（${item.fund.code}）缺少结构化持仓证据，未纳入统计。`);
  let sourceFailureCount = 0;
  let holdingsCompleted = 0;
  const enriched = await mapLimit(holdings, settings?.concurrency ?? 5, async (holding) => {
    const sourceErrors = [];
    const [klineRows, reportItems] = await Promise.all([
      fetchTinfo(baseUrl, "/api/kline", { code: holding.code, from: klineStart, to: asOf }, config.sources)
        .catch((error) => {
          sourceErrors.push(`行情：${errorMessage(error)}`);
          return [];
        }),
      isAshareCode(holding.code)
        ? fetchTinfo(baseUrl, "/api/company/reports", { code: holding.code, page: 1 }, {
            ...config.sources,
            requestTimeoutMs: settings?.forecastRequestTimeoutMs ?? 120_000,
            requestAttempts: settings?.forecastRequestAttempts ?? 1,
          }).catch((error) => {
            sourceErrors.push(`研报：${errorMessage(error)}`);
            return [];
          })
        : Promise.resolve([]),
    ]);
    const klineMarket = buildHoldingMarketSnapshot(klineRows, asOf, periods);
    const marketRow = markets.get(normalizeSecurityCode(holding.code));
    const marketPrice = numberOrNull(marketRow?.NEW_PRICE);
    const marketCapYuan = numberOrNull(marketRow?.TOTAL_MARKET_CAP);
    const market = {
      ...klineMarket,
      price: marketPrice ?? klineMarket.price,
      priceDate: String(marketRow?.MAX_TRADE_DATE ?? klineMarket.priceDate ?? "").slice(0, 10),
      marketCapYi: marketCapYuan !== null ? marketCapYuan / 100_000_000 : null,
    };
    const forecasts = aggregateReportForecasts(reportItems, {
      years: forecastYears,
      currentPrice: market.price,
      marketCapYi: market.marketCapYi,
    });
    if (sourceErrors.length) {
      sourceFailureCount += sourceErrors.length;
      warnings.push(`${holding.name}（${holding.code}）${sourceErrors.join("；")}`);
    }
    holdingsCompleted += 1;
    log("holding_statistics_progress", {
      completed: holdingsCompleted,
      total: holdings.length,
      code: holding.code,
      forecastYears: forecasts.length,
      sourceErrors: sourceErrors.length,
    });
    return { ...holding, market, forecasts };
  });

  const html = renderFundHoldingsStatisticsHtml({
    asOf,
    reportDate,
    quarter: reportQuarter,
    fundsAnalyzed: evidences.length,
    holdings: enriched,
    periods,
    forecastYears,
    baseUrl,
    warnings,
  });
  await atomicWrite(path, `${html}\n`);
  await rm(legacyMarkdownPath, { force: true });
  await writeJson(statePath, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    signature,
    asOf,
    reportDate,
    quarter: reportQuarter,
    fundsAnalyzed: evidences.length,
    holdings: enriched,
    warnings,
    sourceFailureCount,
  });
  return { path, skipped: false, holdings: enriched.length };
}

async function fetchHoldingMarkets(baseUrl, codes, settings, sourceConfig) {
  const aShareCodes = codes.filter(isAshareCode);
  const rows = [];
  const batchSize = settings?.marketBatchSize ?? 50;
  for (let offset = 0; offset < aShareCodes.length; offset += batchSize) {
    const chunk = aShareCodes.slice(offset, offset + batchSize);
    const filter = `(SECUCODE in (${chunk.map((code) => `"${code}"`).join(",")}))`;
    try {
      const data = await fetchTinfo(baseUrl, "/api/companies/filter", {
        st: "TOTAL_MARKET_CAP",
        sr: -1,
        ps: batchSize,
        p: 1,
        sty: "SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,NEW_PRICE,TOTAL_MARKET_CAP,MAX_TRADE_DATE",
        filter,
      }, sourceConfig);
      rows.push(...(Array.isArray(data?.data) ? data.data : []));
    } catch (error) {
      log("holding_market_batch_failed", { codes: chunk.join(","), error: errorMessage(error) });
    }
  }
  return rows;
}

async function readOptionalJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`invalid JSON state ${path}: ${errorMessage(error)}`);
  }
}

async function collectFundEvidence({ item, asOf, reportDate, priorReportDate, reportQuarter, baseUrl, config }) {
  const currentNotice = mapNotice(item.currentNotice, item.fund.code);
  const priorNotice = item.priorNotice ? mapNotice(item.priorNotice, item.fund.code) : null;
  const [fundInfo, positionRows, currentReport, priorReport] = await Promise.all([
    fetchTinfo(baseUrl, "/api/fund/info", { code: `${item.fund.code}.OF` }, config.sources),
    fetchTinfo(baseUrl, "/api/fund/position", { code: `${item.fund.code}.OF`, num: 5 }, config.sources),
    fetchNoticeContent(currentNotice.id, config.sources),
    priorNotice ? fetchNoticeContent(priorNotice.id, config.sources) : Promise.resolve(null),
  ]);
  const positions = normalizePositionPeriods(positionRows);
  const currentPositionRaw = positions.get(reportDate) ?? { reportDate, holdings: [] };
  const priorPositionRaw = positions.get(priorReportDate) ?? { reportDate: priorReportDate, holdings: [] };
  const currentPosition = {
    ...currentPositionRaw,
    holdings: selectDisclosedHoldings(currentPositionRaw.holdings, currentReport.content),
  };
  const priorPosition = {
    ...priorPositionRaw,
    holdings: selectDisclosedHoldings(priorPositionRaw.holdings, priorReport?.content ?? ""),
  };
  const currentFundShares = parseFundTotalShares(currentReport.content);
  const priorFundShares = priorReport ? parseFundTotalShares(priorReport.content) : null;
  const codes = [...new Set([...currentPosition.holdings, ...priorPosition.holdings].map((holding) => holding.code))];
  const klineStart = daysBefore(priorReportDate, 7);
  const klineRows = await mapLimit(codes, config.sources.marketConcurrency, async (code) => {
    try {
      const rows = await fetchTinfo(baseUrl, "/api/kline", { code, from: klineStart, to: asOf }, config.sources);
      return [code, Array.isArray(rows) ? rows : []];
    } catch (error) {
      log("kline_failed", { fundCode: item.fund.code, code, error: errorMessage(error) });
      return [code, []];
    }
  });
  const returnsByCode = Object.fromEntries(klineRows.map(([code, rows]) => [code, {
    periodReturnPct: returnBetweenKlines(rows, priorReportDate, reportDate),
    postReportReturnPct: returnBetweenKlines(rows, reportDate, asOf),
  }]));
  const changes = analyzePositionChanges({
    currentHoldings: currentPosition.holdings,
    previousHoldings: priorPosition.holdings,
    currentFundShares,
    previousFundShares: priorFundShares,
    returnsByCode,
    actionThresholdPct: config.analysis.actionThresholdPct,
    assessmentThresholdPct: config.analysis.assessmentThresholdPct,
  });
  const topContributors = changes
    .filter((item) => item.estimatedContributionPct !== null)
    .sort((a, b) => b.estimatedContributionPct - a.estimatedContributionPct)
    .slice(0, config.analysis.topContributionCount);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    asOf,
    reportDate,
    previousReportDate: priorReportDate,
    quarter: reportQuarter,
    methodology: {
      action: `持股数量/全基金总份额变动超过 ±${config.analysis.actionThresholdPct}% 判定加减仓`,
      contribution: "季初与季末权重均值 × 报告期个股涨跌幅，仅为估算",
      assessment: `季末至数据截止日涨跌绝对值不足 ${config.analysis.assessmentThresholdPct}% 记为中性`,
      entryExitScope: "新进/退出仅指公开持仓明细，不代表首次买入或清仓",
    },
    fund: {
      ...item.fund,
      manager: fundInfo.manager ?? "",
      company: fundInfo.company ?? "",
      style: fundInfo.style ?? "",
      selectedFromRawRank: item.fund.rank,
    },
    reports: {
      current: { ...currentNotice, totalFundShares: currentFundShares },
      previous: priorNotice ? { ...priorNotice, totalFundShares: priorFundShares } : null,
      managementDiscussion: extractManagementDiscussion(
        currentReport.content,
        config.analysis.managementDiscussionMaxChars,
      ),
    },
    positions: {
      current: currentPosition.holdings,
      previous: priorPosition.holdings,
      changes,
      topEstimatedContributors: topContributors,
    },
    sources: {
      fundInfo: `${baseUrl}/api/fund/info?code=${item.fund.code}.OF`,
      fundPositions: `${baseUrl}/api/fund/position?code=${item.fund.code}.OF&num=5`,
      klineTemplate: `${baseUrl}/api/kline?code={证券代码}&from=${klineStart}&to=${asOf}`,
      noticeContent: `https://np-cnotice-fund.eastmoney.com/api/content/ann?client_source=web_fund&show_all=1&art_code=${currentNotice.id}`,
    },
  };
}

async function fetchFundNotices(fundCode, sourceConfig) {
  const rows = [];
  let pages = 1;
  for (let page = 1; page <= Math.min(pages, sourceConfig.noticeMaxPages); page += 1) {
    const url = new URL("https://api.fund.eastmoney.com/f10/JJGG");
    url.searchParams.set("fundcode", fundCode);
    url.searchParams.set("pageIndex", String(page));
    url.searchParams.set("pageSize", String(sourceConfig.noticePageSize));
    url.searchParams.set("type", "0");
    const body = await fetchJsonWithRetry(url, {
      ...sourceConfig,
      headers: { Referer: "https://fund.eastmoney.com/" },
    });
    if (body.ErrCode !== 0) throw new Error(`Eastmoney notices failed: ${body.ErrMsg ?? body.ErrCode}`);
    rows.push(...(Array.isArray(body.Data) ? body.Data : []));
    pages = Math.max(1, Math.ceil(Number(body.TotalCount ?? rows.length) / sourceConfig.noticePageSize));
  }
  return rows;
}

async function fetchNoticeContent(noticeId, sourceConfig) {
  const url = new URL("https://np-cnotice-fund.eastmoney.com/api/content/ann");
  url.searchParams.set("client_source", "web_fund");
  url.searchParams.set("show_all", "1");
  url.searchParams.set("art_code", noticeId);
  const body = await fetchJsonWithRetry(url, sourceConfig);
  if (body.success !== 1 || !body.data?.notice_content) throw new Error(`Eastmoney notice content missing: ${noticeId}`);
  return {
    title: String(body.data.notice_title ?? ""),
    content: String(body.data.notice_content),
    attachmentUrl: String(body.data.attach_url ?? ""),
  };
}

async function fetchTinfo(baseUrl, path, params, sourceConfig) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const body = await fetchJsonWithRetry(url, sourceConfig);
  if (body.code !== 200) throw new Error(`stock-info ${path} failed: ${body.msg ?? body.code}`);
  return body.data;
}

async function fetchJsonWithRetry(url, sourceConfig) {
  const attempts = Number(sourceConfig.requestAttempts ?? 3);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: sourceConfig.headers ?? {},
        signal: AbortSignal.timeout(Number(sourceConfig.requestTimeoutMs ?? 30_000)),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await delay(500 * (2 ** attempt));
    }
  }
  throw lastError;
}

async function createLlmClient(config, stateDir) {
  const model = process.env.FUND_RESEARCH_LLM_MODEL || config.llm.model;
  const baseUrl = String(process.env.FUND_RESEARCH_LLM_BASE_URL || process.env.LLM_BASE_URL || config.llm.baseUrl).replace(/\/$/, "");
  const provider = "openai";
  const apiKeyEnv = process.env.FUND_RESEARCH_LLM_API_KEY_ENV || config.llm.apiKeyEnv;
  const apiKey = await resolveApiKey(config.llm, apiKeyEnv);
  if (!apiKey) {
    throw new Error(
      `missing LLM API key: check ${config.llm.apiKeyFile ?? "llm.apiKey"}, ${apiKeyEnv}, or LLM_API_KEY`,
    );
  }
  const client = new SharedLlmClient({
    cacheStore: new SQLiteLlmCacheStore(join(stateDir, "llm-cache.sqlite")),
    providers: {
      [provider]: createResponsesProvider({ name: provider, baseUrl, apiKey }),
    },
    providerConcurrency: { [provider]: config.llm.concurrency },
  });
  return { client, provider, model };
}

async function resolveApiKey(llmConfig, apiKeyEnv) {
  if (typeof llmConfig.apiKey === "string" && llmConfig.apiKey.trim()) return llmConfig.apiKey.trim();
  if (llmConfig.apiKeyFile) {
    const configuredPath = String(llmConfig.apiKeyFile);
    const filePath = configuredPath === "~"
      ? homedir()
      : configuredPath.startsWith("~/")
        ? resolve(homedir(), configuredPath.slice(2))
        : resolve(rootDir, configuredPath);
    try {
      const credentials = JSON.parse(await readFile(filePath, "utf8"));
      const field = String(llmConfig.apiKeyField || "OPENAI_API_KEY");
      const value = credentials?.[field];
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`invalid LLM apiKeyFile ${filePath}: ${errorMessage(error)}`);
    }
  }
  return process.env[apiKeyEnv] || process.env.LLM_API_KEY || "";
}

async function loadConfig(configPath) {
  const base = JSON.parse(await readFile(configPath, "utf8"));
  const localPath = configPath.endsWith(".json")
    ? configPath.replace(/\.json$/, ".local.json")
    : `${configPath}.local.json`;
  try {
    const local = JSON.parse(await readFile(localPath, "utf8"));
    return deepMerge(base, local);
  } catch (error) {
    if (error?.code === "ENOENT") return base;
    throw new Error(`invalid local fund research config ${localPath}: ${errorMessage(error)}`);
  }
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return merged;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseArgs(args) {
  const options = { config: "config/fund-quarterly-research.json", dryRun: false, force: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    if (arg === "--force") { options.force = true; continue; }
    if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
    const key = {
      "--as-of": "asOf",
      "--report-date": "reportDate",
      "--limit": "limit",
      "--fund-code": "fundCode",
      "--base-url": "baseUrl",
      "--output": "output",
      "--config": "config",
      "--concurrency": "concurrency",
    }[arg];
    if (!key) throw new Error(`unknown argument: ${arg}`);
    const value = args[++index];
    if (!value) throw new Error(`missing value for ${arg}`);
    options[key] = ["limit", "concurrency"].includes(key) ? positiveInteger(value, arg) : value;
  }
  if (options.fundCode && !/^\d{6}$/.test(options.fundCode)) throw new Error("--fund-code must be six digits");
  return options;
}

function printHelp() {
  console.log(`Usage: npm run research:fund-quarterly -- [options]

Options:
  --as-of YYYY-MM-DD       Data cutoff in Asia/Shanghai (default: today)
  --report-date YYYY-MM-DD Override the target quarterly report date
  --limit N                Raw three-month ranking size (default: 100)
  --fund-code 005844       Process one fund only if it is in the selected ranking
  --base-url URL           stock-info API base URL
  --output PATH            Markdown output directory
  --config PATH            JSON config path
  --concurrency N          Concurrent per-fund analysis jobs
  --dry-run                Fetch and write evidence without calling the LLM
  --force                  Rebuild reports that already exist
`);
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
  return results;
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function summarize(items) {
  const summary = {};
  for (const item of items) summary[item.status] = (summary[item.status] ?? 0) + 1;
  return summary;
}

function monthsBefore(date, months) {
  const [year, month, day] = date.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

function daysBefore(date, days) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - days);
  return parsed.toISOString().slice(0, 10);
}

function resolvePerformancePeriods(asOf, definitions) {
  return definitions.map((definition) => ({
    key: String(definition.key),
    label: String(definition.label),
    startDate: definition.yearStart
      ? `${asOf.slice(0, 4)}-01-01`
      : daysBefore(asOf, positiveInteger(definition.days, `performance period ${definition.key}`)),
  }));
}

function resolveForecastYears(asOf, configuredYears) {
  if (Array.isArray(configuredYears) && configuredYears.length) {
    return [...new Set(configuredYears.map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
  }
  const year = Number(asOf.slice(0, 4));
  return [year, year + 1, year + 2];
}

function normalizeSecurityCode(value) {
  const text = String(value ?? "").trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(text)) return text;
  if (/^(SH|SZ|BJ)\d{6}$/.test(text)) return `${text.slice(2)}.${text.slice(0, 2)}`;
  return text;
}

function isAshareCode(value) {
  return /^\d{6}\.(SH|SZ|BJ)$/.test(normalizeSecurityCode(value));
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function shanghaiToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function log(event, details = {}) {
  console.log(JSON.stringify({ event, ...details }));
}

function errorMessage(error) {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? error.cause.message : error.cause ? String(error.cause) : "";
    return cause ? `${error.message}: ${cause}` : error.message;
  }
  return error ? String(error) : "";
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
