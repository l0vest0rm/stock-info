#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateEarningsEvents,
  analyzeCandidate,
  attachConsensus,
  attachMarketsAndFilter,
  daysBefore,
  previousQuarterEndDate,
  prioritizeEarningsEvents,
  rankAnalyzedCandidates,
  renderEvidenceMarkdown,
  renderPrompt,
  trimDate,
} from "./lib/earnings-research.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await readFile(resolve(rootDir, options.config), "utf8"));
  const asOf = options.asOf ?? shanghaiToday();
  const reportDate = options.reportDate ?? previousQuarterEndDate(asOf);
  const days = options.days ?? config.defaultDays;
  const limit = options.limit ?? config.defaultLimit;
  const fromDate = daysBefore(asOf, days - 1);
  const runId = `${asOf}-${new Date().toISOString().slice(11, 19).replaceAll(":", "")}`;
  const outputDir = resolve(rootDir, options.output ?? `data/earnings-research/${runId}`);
  const baseUrl = options.baseUrl ?? config.baseUrl;
  const request = {
    asOf,
    reportDate,
    fromDate,
    days,
    limit,
    baseUrl,
    includeConsensus: options.includeConsensus,
    fixtureDir: options.fixtureDir ? resolve(options.fixtureDir) : null,
    configVersion: config.version,
  };

  const source = options.fixtureDir
    ? await loadFixture(resolve(options.fixtureDir))
    : await loadLiveSource({ baseUrl, reportDate, fromDate, asOf, config });
  const allRows = [...source.performanceRows, ...source.forecastRows];
  const futureRowsExcluded = allRows.filter((row) => trimDate(row.NOTICE_DATE ?? row.UPDATE_DATE) > asOf).length;
  const events = aggregateEarningsEvents(source.performanceRows, source.forecastRows, { asOf, fromDate, reportDate });
  const marketCandidateEvents = prioritizeEarningsEvents(events, config.marketCandidateLimit);
  const marketRows = options.fixtureDir
    ? source.marketRows
    : await fetchMarketRows(baseUrl, marketCandidateEvents.map((event) => event.code), config.marketBatchSize);
  const marketCandidates = attachMarketsAndFilter(marketCandidateEvents, marketRows, config.filters);
  const analysisPoolSize = Math.min(config.analysisPoolLimit, Math.max(limit * 2, 20), marketCandidates.length);
  const candidates = marketCandidates.slice(0, analysisPoolSize);

  const analyzed = await mapLimit(candidates, config.financeConcurrency, async (candidate) => {
    const statements = options.fixtureDir
      ? statementsForFixture(source, candidate.code)
      : await fetchStatements(baseUrl, candidate.code);
    return analyzeCandidate(candidate, statements, {
      asOf,
      forecastYear: Number(asOf.slice(0, 4)),
      ranking: config.ranking,
    });
  });

  const ranked = rankAnalyzedCandidates(analyzed, config.ranking).slice(0, limit);
  let withConsensus = ranked;
  if (options.includeConsensus) {
    const consensusLimit = Math.min(config.consensusLimit, ranked.length);
    withConsensus = [];
    for (let index = 0; index < ranked.length; index += 1) {
      const candidate = ranked[index];
      if (index >= consensusLimit) {
        withConsensus.push(candidate);
        continue;
      }
      const rows = options.fixtureDir
        ? source.reportForecasts?.[candidate.code] ?? []
        : await fetchTinfo(baseUrl, "/api/report/forecast", { code: candidate.code }, 120_000).catch((error) => {
          candidate.warnings.push(`研报预测获取失败：${error.message}`);
          return [];
        });
      withConsensus.push(attachConsensus(candidate, rows));
    }
  }

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ...request,
    stats: {
      performanceRowsRead: source.performanceRows.length,
      forecastRowsRead: source.forecastRows.length,
      futureRowsExcluded,
      eventsEligible: events.length,
      marketCandidatesRequested: marketCandidateEvents.length,
      candidatesAnalyzed: analyzed.length,
      candidatesSelected: withConsensus.length,
    },
    candidates: withConsensus,
  };
  const evidence = renderEvidenceMarkdown(payload);
  const evidencePath = join(outputDir, "evidence.md");
  const outputPath = join(outputDir, "recommendations.md");
  const promptTemplate = await readFile(resolve(rootDir, "prompts/earnings-recommendation.md"), "utf8");
  const prompt = renderPrompt(promptTemplate, {
    asOf,
    reportDate,
    evidencePath,
    outputPath,
    evidence,
  });

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeJson(join(outputDir, "request.json"), request),
    writeJson(join(outputDir, "evidence.json"), payload),
    writeFile(evidencePath, evidence, "utf8"),
    writeFile(join(outputDir, "prompt.md"), prompt, "utf8"),
  ]);
  console.log(JSON.stringify({
    ok: true,
    outputDir,
    candidates: withConsensus.length,
    evidencePath,
    promptPath: join(outputDir, "prompt.md"),
    recommendationsPath: outputPath,
  }, null, 2));
}

function parseArgs(args) {
  const options = {
    config: "config/earnings-research.json",
    includeConsensus: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--include-consensus") {
      options.includeConsensus = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    const key = {
      "--as-of": "asOf",
      "--report-date": "reportDate",
      "--days": "days",
      "--limit": "limit",
      "--base-url": "baseUrl",
      "--output": "output",
      "--fixture-dir": "fixtureDir",
      "--config": "config",
    }[arg];
    if (!key) throw new Error(`unknown argument: ${arg}`);
    const value = args[++index];
    if (!value) throw new Error(`missing value for ${arg}`);
    options[key] = ["days", "limit"].includes(key) ? positiveInteger(value, arg) : value;
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/earnings-research.mjs [options]

Options:
  --as-of YYYY-MM-DD        Data cutoff in Asia/Shanghai (default: today)
  --report-date YYYY-MM-DD  Quarter end (default: latest completed quarter)
  --days N                  Recent announcement window
  --limit N                 Maximum candidates in the evidence pack
  --base-url URL            stock-info API base URL
  --include-consensus       Fetch the slower report forecast endpoint
  --fixture-dir PATH        Use fixture.json instead of live network data
  --output PATH             Output directory relative to the repo
  --config PATH             Config path relative to the repo
`);
}

async function loadLiveSource({ reportDate, fromDate, asOf, config }) {
  const [performanceRows, forecastRows] = await Promise.all([
    fetchEastmoneyRows("RPT_FCI_PERFORMANCEE", reportDate, fromDate, asOf, config.pageSize),
    fetchEastmoneyRows("RPT_PUBLIC_OP_NEWPREDICT", reportDate, fromDate, asOf, config.pageSize),
  ]);
  return { performanceRows, forecastRows };
}

async function fetchEastmoneyRows(reportName, reportDate, fromDate, asOf, pageSize) {
  const rows = [];
  let pages = 1;
  for (let page = 1; page <= pages; page += 1) {
    const params = {
      reportName,
      columns: "ALL",
      filter: reportName === "RPT_FCI_PERFORMANCEE"
        ? `(SECURITY_TYPE_CODE in ("058001001","058001008"))(TRADE_MARKET_CODE!="069001017")(REPORT_DATE='${reportDate}')`
        : `(REPORT_DATE='${reportDate}')`,
      pageNumber: page,
      pageSize,
      sortTypes: "-1,-1",
      sortColumns: reportName === "RPT_FCI_PERFORMANCEE" ? "UPDATE_DATE,SECURITY_CODE" : "NOTICE_DATE,SECURITY_CODE",
    };
    const url = new URL("https://datacenter-web.eastmoney.com/api/data/v1/get");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const body = await fetchJsonWithRetry(url, {
      headers: { Referer: "https://emweb.securities.eastmoney.com/" },
      timeoutMs: 30_000,
    });
    if (body.success !== true) throw new Error(`eastmoney ${reportName} failed: ${body.message ?? body.code}`);
    const pageRows = Array.isArray(body.result?.data) ? body.result.data : [];
    pages = Math.max(1, Number(body.result?.pages ?? 1));
    rows.push(...pageRows);
    const dates = pageRows.map((row) => trimDate(row.NOTICE_DATE ?? row.UPDATE_DATE)).filter(Boolean);
    if (dates.length && dates.every((date) => date < fromDate || date > asOf) && dates.some((date) => date < fromDate)) break;
  }
  return rows;
}

async function fetchMarketRows(baseUrl, codes, batchSize) {
  const rows = [];
  for (let offset = 0; offset < codes.length; offset += batchSize) {
    const chunk = codes.slice(offset, offset + batchSize);
    if (!chunk.length) continue;
    const filter = `(SECUCODE in (${chunk.map((code) => `"${code}"`).join(",")}))`;
    const data = await fetchTinfo(baseUrl, "/api/companies/filter", {
      st: "TOTAL_MARKET_CAP",
      sr: -1,
      ps: batchSize,
      p: 1,
      sty: "SECUCODE,SECURITY_NAME_ABBR,NEW_PRICE,TOTAL_MARKET_CAP,PE9,PBNEWMRQ,NETPROFIT_YOY_RATIO,ZXGXL,ALLCORP_NUM,MAX_TRADE_DATE",
      filter,
    });
    rows.push(...(Array.isArray(data.data) ? data.data : []));
  }
  return rows;
}

async function fetchStatements(baseUrl, code) {
  const [income, balance, cashflow] = await Promise.all([
    fetchTinfo(baseUrl, "/api/finance/income", { code }),
    fetchTinfo(baseUrl, "/api/finance/balance", { code }),
    fetchTinfo(baseUrl, "/api/finance/cashflow", { code }),
  ]);
  return { income, balance, cashflow };
}

async function fetchTinfo(baseUrl, path, params, timeoutMs = 30_000) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const body = await fetchJsonWithRetry(url, { timeoutMs });
  if (body.code !== 200) throw new Error(`stock-info ${path} failed: ${body.msg ?? body.code}`);
  return body.data;
}

async function fetchJsonWithRetry(url, { headers = {}, timeoutMs }, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await delay(500 * (2 ** attempt));
    }
  }
  throw lastError;
}

async function loadFixture(directory) {
  return JSON.parse(await readFile(join(directory, "fixture.json"), "utf8"));
}

function statementsForFixture(source, code) {
  return {
    income: source.statements?.income?.[code] ?? [],
    balance: source.statements?.balance?.[code] ?? [],
    cashflow: source.statements?.cashflow?.[code] ?? [],
  };
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
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
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

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
