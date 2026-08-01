#!/usr/bin/env node

/**
 * Point-in-time test for the A-share institutional-holding Top 100 portfolio.
 *
 * The selection is refreshed only after the statutory reporting deadline for
 * each quarter.  Signals use the previous close and orders are valued at the
 * next close, so the script deliberately does not use same-close information.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildInstitutionalTrackTaxonomyIndex,
  classifyInstitutionalTrackRow,
} from "./lib/institutional-track-classification.mjs";

const args = parseArgs(process.argv.slice(2));
const baseUrl = args["base-url"] ?? "https://tinfo.cc";
const to = args.to ?? "2026-07-31";
const from = args.from ?? "2023-12-01";
const oneWayCost = Number(args["one-way-cost-bp"] ?? "15") / 10_000;
const output = path.resolve(args.output ?? "docs/research/机构持仓Top100-风控规则回测.md");
const portfolioSizes = parsePortfolioSizes(args["portfolio-sizes"] ?? "100");
const holdingType = String(args["holding-type"] ?? "0");
const industryExperiments = args["industry-experiments"] === "true";
const concentrationRules = args["concentration-rules"] === "true";
const maxConcentrationInitial = args["max-concentration-initial"] === "true";
const initialStockCounts = parseStyleStockCounts(args["initial-stock-counts"] ?? "6");
const institutionCountGrowth = args["institution-count-growth"] === "true";
const institutionGrowthWeight = Number(args["institution-growth-weight"] ?? "0.5");
const stockSleeveWeight = Number(args["stock-sleeve-weight"] ?? "1");
const snapshotPath = new URL("../web/src/config/institutional-track-snapshot.json", import.meta.url);
const industryGroupsPath = new URL("../config/institutional-backtest-industry-groups.json", import.meta.url);
const trackTaxonomyPath = new URL("../web/src/config/institutional-track-taxonomy.json", import.meta.url);
const trackOverridesPath = new URL("../web/src/config/institutional-track-overrides.json", import.meta.url);
const industrySnapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const industryAliases = new Map(Object.entries(JSON.parse(await readFile(industryGroupsPath, "utf8")).aliases ?? {}));
const trackTaxonomy = JSON.parse(await readFile(trackTaxonomyPath, "utf8"));
const trackTaxonomyIndex = buildInstitutionalTrackTaxonomyIndex(trackTaxonomy);
const trackOverrides = JSON.parse(await readFile(trackOverridesPath, "utf8"));
const snapshotByCode = new Map(industrySnapshot.rows.map((row) => [String(row.code), {
  industry: String(row.industry || "未分类"),
  concepts: Array.isArray(row.concepts) ? row.concepts.map(String) : [],
  primaryTrack: String(row.primaryTrack || ""),
  secondaryTrack: String(row.secondaryTrack || ""),
}]));

if (!Number.isFinite(oneWayCost) || oneWayCost < 0 || oneWayCost > 0.01) {
  throw new Error("--one-way-cost-bp must be between 0 and 100");
}
if (!Number.isFinite(stockSleeveWeight) || stockSleeveWeight <= 0 || stockSleeveWeight > 1) {
  throw new Error("--stock-sleeve-weight must be in (0, 1]");
}
if (!Number.isFinite(institutionGrowthWeight) || institutionGrowthWeight < 0 || institutionGrowthWeight > 1) {
  throw new Error("--institution-growth-weight must be in [0, 1]");
}

const reportDates = quarterEndsBetween("2024-03-31", "2026-03-31");
const rankingDates = reportDates;
const rankingRows = await Promise.all(rankingDates.map(async (reportDate) => ({
  reportDate,
  rows: await fetchTop100(baseUrl, reportDate, holdingType, "HOLD_VALUE"),
})));
const rankingByDate = new Map(rankingRows.map((item) => [item.reportDate, item.rows]));
const activeRankingRows = reportDates.map((reportDate) => ({ reportDate, rows: rankingByDate.get(reportDate) ?? [] }));
const priorInstitutionCountsByDate = institutionCountGrowth
  ? new Map(await mapConcurrent([...new Set(reportDates.map(previousQuarterEnd))], 2, async (reportDate) => [reportDate, await fetchAllInstitutionCounts(reportDate, holdingType)]))
  : new Map();
const universe = [...new Set(activeRankingRows.flatMap(({ rows }) => rows.map((row) => row.code)))];
const liveMetadataByNumber = await fetchCurrentMetadata(baseUrl, universe.map((code) => code.slice(0, 6)));
const priceRows = await mapConcurrent(universe, 6, async (code) => [code, await fetchKline(baseUrl, code, from, to)]);
const priceByCode = new Map(priceRows);
const masterDates = [...new Set(priceRows.flatMap(([, rows]) => rows.map((row) => row.date)))].sort();
const schedules = activeRankingRows
  .map(({ reportDate, rows }) => {
    const previousCounts = priorInstitutionCountsByDate.get(previousQuarterEnd(reportDate));
    if (institutionCountGrowth && !previousCounts) throw new Error(`${reportDate}: missing complete prior institution-count data`);
    const candidates = rows.map((row, index) => {
      const snapshot = snapshotByCode.get(row.code) ?? { industry: "未分类", concepts: [] };
      const liveMetadata = liveMetadataByNumber.get(row.code.slice(0, 6));
      const industry = liveMetadata?.industry ?? snapshot.industry;
      const normalizedIndustry = industryAliases.get(industry) ?? industry;
      const candidate = {
        ...row,
        ...snapshot,
        industry: normalizedIndustry,
        dividendYield: liveMetadata?.dividendYield ?? null,
        profitGrowth3Y: liveMetadata?.profitGrowth3Y ?? null,
        holdValueRank: index + 1,
        institutionCount: row.holderCount,
        previousInstitutionCount: institutionCountGrowth ? (previousCounts.get(row.code) ?? 0) : null,
      };
      return {
        ...candidate,
        institutionCountGrowth: institutionCountGrowth ? candidate.institutionCount - candidate.previousInstitutionCount : null,
        firstInstitutionEntry: institutionCountGrowth && !previousCounts.has(row.code),
        track: deriveTrack(candidate),
      };
    });
    if (institutionCountGrowth) applyCompositeInstitutionScore(candidates, institutionGrowthWeight);
    return {
      reportDate,
      availableDate: availabilityDate(reportDate),
      tradeDate: nextTradingDate(masterDates, availabilityDate(reportDate)),
      candidates,
    };
  })
  .filter((item) => item.tradeDate && item.tradeDate <= to);

if (schedules.length < 2) throw new Error("not enough completed quarterly holding schedules");
if (masterDates.length === 0) throw new Error("no kline data");

const pointByCode = new Map([...priceByCode.entries()].map(([code, rows]) => [code, buildPoints(rows)]));
const metadataByCode = new Map(schedules.flatMap((schedule) => schedule.candidates.map((candidate) => [candidate.code, candidate])));
const startDate = schedules[0].tradeDate;
const testDates = masterDates.filter((date) => date >= startDate && date <= to);
const selectionVariants = [
  { id: "top", name: "Top20（无行业约束）" },
  { id: "top-classified", name: "Top20（使用当前行业标签）", requireIndustry: true },
  { id: "cap10", name: "Top20，行业上限10%", industryCap: 0.10, requireIndustry: true },
  { id: "cap15", name: "Top20，行业上限15%", industryCap: 0.15, requireIndustry: true },
  { id: "cap20", name: "Top20，行业上限20%", industryCap: 0.20, requireIndustry: true },
  { id: "cap25", name: "Top20，行业上限25%", industryCap: 0.25, requireIndustry: true },
  { id: "balance10x2", name: "Top10行业×各2只（行业均衡）", industryCount: 10, industrySlots: 2, requireIndustry: true },
  { id: "balance10x2-exclude-weak", name: "前63日剔除最弱25%行业后，Top10行业×各2只", industryCount: 10, industrySlots: 2, requireIndustry: true, excludeWeakIndustries: true },
  { id: "cap10-exclude-weak", name: "Top20，行业上限10%，剔除前63日最弱25%行业", industryCap: 0.10, requireIndustry: true, excludeWeakIndustries: true },
  { id: "cap15-exclude-ai", name: "Top20，行业上限15%，剔除当前AI概念股", industryCap: 0.15, requireIndustry: true, excludeAi: true },
];
const strategies = [
  { id: "hold", name: "季度等权持有（基准）", signal: "always" },
  { id: "ma20", name: "收盘跌破MA20全卖；重新站上即买回", signal: "ma20" },
  { id: "ma60", name: "收盘跌破MA60全卖；重新站上即买回", signal: "ma60" },
  { id: "ma60-half", name: "收盘跌破MA60减半；重新站上恢复", signal: "ma60", riskWeight: 0.5 },
  { id: "ma60-buffer", name: "跌破0.98×MA60卖；站上1.02×MA60买", signal: "ma60-buffer" },
  { id: "dual-ma", name: "收盘低于MA60且MA20低于MA60卖；双重恢复再买", signal: "dual-ma" },
  { id: "dual-ma-half", name: "双均线转空减半；双重恢复", signal: "dual-ma", riskWeight: 0.5 },
  { id: "dd15-dual", name: "距60日高点回撤15%且双均线转空卖；双重恢复再买", signal: "dd15-dual" },
  { id: "dd20-dual", name: "距60日高点回撤20%且双均线转空卖；双重恢复再买", signal: "dd20-dual" },
];

const activeVariants = industryExperiments
  ? selectionVariants
  : maxConcentrationInitial ? initialStockCounts.map((stockCount) => createStyleVariant(stockCount, institutionCountGrowth, institutionGrowthWeight))
  : [{ id: "top", name: "Top-N（无行业约束）" }];
const activeStrategies = concentrationRules
  ? [
      { id: "hold", name: maxConcentrationInitial ? "成长50%/红利20%（基准）" : "基金Top20季度等权（基准）", signal: "always" },
      { id: "hold-concentration", name: maxConcentrationInitial ? "成长50%/红利20% + 15/20/25集中度再平衡" : "基金Top20 + 15/20/25集中度再平衡", signal: "always", concentrationRules: true },
    ]
  : industryExperiments ? strategies.filter((strategy) => strategy.id === "hold") : strategies;
const results = activeVariants.flatMap((variant) => (variant.styleAllocation ? [variant.styleAllocation.stockCount] : portfolioSizes).flatMap((portfolioSize) => {
  const scheduleByDate = new Map(schedules.map((item) => {
    const selection = variant.styleAllocation
      ? selectStyleCandidates(item.candidates, variant.styleAllocation)
      : { codes: selectCandidates({ candidates: item.candidates, portfolioSize, variant, pointByCode, previousDate: previousTradingDate(masterDates, item.tradeDate) }) };
    return [item.tradeDate, { ...item, ...selection }];
  }));
  const selectionDetails = buildSelectionDetails([...scheduleByDate.values()], stockSleeveWeight);
  return activeStrategies.map((strategy) => {
    const result = runBacktest({ strategy, dates: testDates, scheduleByDate, pointByCode, metadataByCode, oneWayCost, recentFrom: "2025-08-01", stockSleeveWeight });
    return { portfolioSize, variant, selectionDetails, ...result, name: `${variant.name}—${strategy.name}` };
  });
}));
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, renderReport({
  baseUrl,
  from,
  to,
  oneWayCost,
  universe: universe.length,
  schedules,
  results,
  portfolioSizes,
  industrySnapshot,
  holdingType,
  industryExperiments,
  concentrationRules,
  stockSleeveWeight,
  maxConcentrationInitial,
  institutionCountGrowth,
  institutionGrowthWeight,
}), "utf8");
console.log(JSON.stringify({ output, holdingType, industryExperiments, concentrationRules, maxConcentrationInitial, institutionCountGrowth, institutionGrowthWeight, initialStockCounts, stockSleeveWeight, strategies: activeStrategies.length, portfolioSizes, variants: activeVariants.length, stocks: universe.length, schedules: schedules.length }, null, 2));

async function fetchTop100(base, reportDate, type, rank = "HOLD_VALUE") {
  const requestPage = (page) => fetchJson(base, "/api/companies/holding/rank", {
    date: reportDate,
    type,
    rank,
    page: String(page),
  });
  const pages = await Promise.all([1, 2].map(requestPage));
  const toRows = (sourceRows) => {
    const seen = new Set();
    return sourceRows.map((row) => ({
      code: String(row.SECUCODE ?? ""),
      name: String(row.SECURITY_NAME_ABBR ?? ""),
      holdValue: Number(row.HOLD_VALUE ?? 0),
      holderCount: Number(row.HOULD_NUM ?? 0),
    })).filter((row) => /^\d{6}\.(SH|SZ|BJ)$/.test(row.code) && !seen.has(row.code) && seen.add(row.code)).slice(0, 100);
  };
  let rows = toRows(pages.flat());
  // Some Eastmoney result pages contain a duplicate security. Only then request
  // page three to restore a true Top100; this endpoint may reject page three
  // when the first two pages already contain 100 unique records.
  if (rows.length < 100) rows = toRows([...pages.flat(), ...(await requestPage(3))]);
  if (rows.length !== 100 || new Set(rows.map((row) => row.code)).size !== 100) {
    throw new Error(`${reportDate}: expected 100 unique A-share holdings, got ${rows.length}`);
  }
  return rows;
}

async function fetchAllInstitutionCounts(reportDate, type) {
  const first = await fetchInstitutionCountPage(reportDate, type, 1);
  if (!Array.isArray(first.data) || !Number.isInteger(first.pages) || first.pages < 1) {
    throw new Error(`${reportDate}: invalid Eastmoney institution-count pagination`);
  }
  const remainingPages = Array.from({ length: first.pages - 1 }, (_, index) => index + 2);
  const pages = [first, ...await mapConcurrent(remainingPages, 3, (page) => fetchInstitutionCountPage(reportDate, type, page))];
  const counts = new Map();
  for (const row of pages.flatMap((page) => page.data)) {
    const code = String(row.SECUCODE ?? "");
    const count = Number(row.HOULD_NUM);
    if (/^\d{6}\.(SH|SZ|BJ)$/.test(code) && Number.isFinite(count) && count >= 0) counts.set(code, count);
  }
  if (counts.size === 0) throw new Error(`${reportDate}: Eastmoney returned no institution-count records`);
  return counts;
}

async function fetchInstitutionCountPage(reportDate, type, page) {
  const url = new URL("https://data.eastmoney.com/dataapi/zlsj/list");
  url.search = new URLSearchParams({
    date: reportDate,
    type,
    zjc: "0",
    sortField: "HOULD_NUM",
    sortDirec: "1",
    pageNum: String(page),
    pageSize: "500",
  }).toString();
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
      const body = await response.json();
      if (!response.ok || body.success !== true || !Array.isArray(body.data)) throw new Error(`${response.status} ${url}`);
      return { data: body.data, pages: Number(body.pages) };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function fetchCurrentMetadata(base, codes) {
  const chunks = Array.from({ length: Math.ceil(codes.length / 10) }, (_, index) => codes.slice(index * 10, index * 10 + 10));
  const pages = await mapConcurrent(chunks, 2, (chunk) => fetchJsonObject(base, "/api/companies/filter", {
    st: "ALLCORP_NUM",
    sr: "-1",
    ps: String(chunk.length),
    p: "1",
    sty: "SECURITY_CODE,INDUSTRY,ZXGXL,NETPROFIT_GROWTHRATE_3Y",
    filter: `(SECURITY_CODE in (${chunk.map((code) => JSON.stringify(code)).join(",")}))`,
  }));
  const map = new Map();
  for (const row of pages.flatMap((page) => Array.isArray(page.data) ? page.data : [])) {
    const code = String(row.SECURITY_CODE ?? "");
    const industry = String(row.INDUSTRY ?? "");
    if (/^\d{6}$/.test(code) && industry) {
      map.set(code, {
        industry,
        dividendYield: numberOrNull(row.ZXGXL),
        profitGrowth3Y: numberOrNull(row.NETPROFIT_GROWTHRATE_3Y),
      });
    }
  }
  if (map.size < new Set(codes).size * 0.95) throw new Error(`current company metadata is materially incomplete: ${map.size}/${new Set(codes).size}`);
  return map;
}

async function fetchKline(base, code, fromDate, toDate) {
  const rows = await fetchJson(base, "/api/kline", { code, period: "day", fq: "qfq", from: fromDate, to: toDate });
  return rows.map((row) => ({
    date: new Date(Number(row[0])).toISOString().slice(0, 10),
    close: Number(row[1]),
  })).filter((row) => Number.isFinite(row.close) && row.close > 0).sort((a, b) => a.date.localeCompare(b.date));
}

function buildPoints(rows) {
  const points = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const closes = rows.slice(0, index + 1).map((row) => row.close);
    const point = { close: rows[index].close, ma20: null, ma60: null, high60: null, return63: null };
    if (closes.length >= 20) point.ma20 = average(closes.slice(-20));
    if (closes.length >= 60) {
      point.ma60 = average(closes.slice(-60));
      point.high60 = Math.max(...closes.slice(-60));
    }
    if (index >= 63) point.return63 = rows[index].close / rows[index - 63].close - 1;
    points.set(rows[index].date, point);
  }
  return points;
}

function deriveTrack(candidate) {
  const override = trackOverrides[candidate.code];
  if (override?.secondaryTrack) return String(override.secondaryTrack);
  if (candidate.secondaryTrack) return String(candidate.secondaryTrack);
  return classifyInstitutionalTrackRow(candidate, trackTaxonomyIndex).secondaryTrack;
}

function selectCandidates({ candidates, portfolioSize, variant, pointByCode, previousDate }) {
  const eligible = variant.requireIndustry ? candidates.filter((candidate) => candidate.industry !== "未分类") : candidates;
  const weakIndustries = variant.excludeWeakIndustries ? bottomMomentumIndustries(eligible, pointByCode, previousDate) : new Set();
  if (variant.industryCount) {
    const groups = new Map();
    for (const candidate of eligible) {
      if (weakIndustries.has(candidate.industry)) continue;
      const group = groups.get(candidate.industry) ?? { holdValue: 0, candidates: [] };
      group.holdValue += candidate.holdValue;
      group.candidates.push(candidate);
      groups.set(candidate.industry, group);
    }
    const selectedGroups = [...groups.entries()]
      .filter(([, group]) => group.candidates.length >= variant.industrySlots)
      .sort((a, b) => b[1].holdValue - a[1].holdValue || a[0].localeCompare(b[0]))
      .slice(0, variant.industryCount);
    const selected = selectedGroups.flatMap(([, group]) => group.candidates.slice(0, variant.industrySlots).map((candidate) => candidate.code));
    if (selected.length !== portfolioSize) throw new Error(`${variant.id}: ${previousDate} only selected ${selected.length}/${portfolioSize} stocks`);
    return selected;
  }
  const perIndustryLimit = variant.industryCap ? Math.max(1, Math.floor(portfolioSize * variant.industryCap + 1e-9)) : Infinity;
  const selected = [];
  const industryCounts = new Map();
  for (const candidate of eligible) {
    if (variant.excludeAi && isAiConcept(candidate)) continue;
    if (weakIndustries.has(candidate.industry)) continue;
    const count = industryCounts.get(candidate.industry) ?? 0;
    if (count >= perIndustryLimit) continue;
    selected.push(candidate.code);
    industryCounts.set(candidate.industry, count + 1);
    if (selected.length === portfolioSize) break;
  }
  if (selected.length !== portfolioSize) {
    throw new Error(`${variant.id}: ${previousDate} only selected ${selected.length}/${portfolioSize} stocks`);
  }
  return selected;
}

function applyCompositeInstitutionScore(candidates, growthWeight) {
  const orderedByGrowth = [...candidates].sort((left, right) => (
    right.institutionCountGrowth - left.institutionCountGrowth
    || left.holdValueRank - right.holdValueRank
    || left.code.localeCompare(right.code)
  ));
  const growthRankByCode = new Map(orderedByGrowth.map((candidate, index) => [candidate.code, index + 1]));
  const denominator = Math.max(candidates.length - 1, 1);
  for (const candidate of candidates) {
    candidate.institutionGrowthRank = growthRankByCode.get(candidate.code);
    candidate.holdValueScore = 1 - (candidate.holdValueRank - 1) / denominator;
    candidate.institutionGrowthScore = 1 - (candidate.institutionGrowthRank - 1) / denominator;
    candidate.compositeScore = (1 - growthWeight) * candidate.holdValueScore + growthWeight * candidate.institutionGrowthScore;
  }
}

function createStyleVariant(stockCount, byInstitutionCountGrowth = false, growthWeight = 0.5) {
  const growthCount = Math.round(stockCount * 5 / 7);
  const dividendCount = stockCount - growthCount;
  const growthWeights = styleBucketWeights(0.50, growthCount);
  const dividendWeights = styleBucketWeights(0.20, dividendCount);
  return {
    id: `growth50-dividend20-${stockCount}`,
    name: `${stockCount}股（成长${growthCount} / 红利${dividendCount}${byInstitutionCountGrowth ? "；持仓市值/机构数增量综合" : ""}）`,
    styleAllocation: { stockCount, growthCount, dividendCount, growthWeights, dividendWeights, byInstitutionCountGrowth, growthWeight },
  };
}

function styleBucketWeights(totalWeight, count) {
  const maxWeight = 0.15;
  if (count === Math.ceil(totalWeight / maxWeight)) {
    return Array.from({ length: count }, (_, index) => index < count - 1 ? maxWeight : totalWeight - maxWeight * (count - 1));
  }
  return Array.from({ length: count }, () => totalWeight / count);
}

function selectStyleCandidates(candidates, { growthCount, dividendCount, growthWeights, dividendWeights, byInstitutionCountGrowth }) {
  const selected = [];
  const industries = new Set();
  const tracks = new Set();
  const orderedCandidates = byInstitutionCountGrowth
    ? [...candidates].sort((left, right) => right.compositeScore - left.compositeScore || right.institutionCountGrowth - left.institutionCountGrowth || left.holdValueRank - right.holdValueRank || left.code.localeCompare(right.code))
    : candidates;
  const choose = (style, count) => {
    for (const candidate of orderedCandidates) {
      if (!matchesStyle(candidate, style) || candidate.industry === "未分类" || industries.has(candidate.industry)) continue;
      // An unclassified track cannot be used to establish a shared exposure, so it
      // is treated as unique here; it remains subject to the stock and industry caps.
      if (candidate.track && tracks.has(candidate.track)) continue;
      selected.push({ ...candidate, style });
      industries.add(candidate.industry);
      if (candidate.track) tracks.add(candidate.track);
      if (selected.filter((item) => item.style === style).length === count) return;
    }
    throw new Error(`style-allocation: only selected ${selected.filter((item) => item.style === style).length}/${count} ${style} candidates with distinct industries and identified tracks`);
  };
  choose("growth", growthCount);
  choose("dividend", dividendCount);
  const targetWeights = new Map([
    ...selected.filter((item) => item.style === "growth").map((candidate, index) => [candidate.code, growthWeights[index]]),
    ...selected.filter((item) => item.style === "dividend").map((candidate, index) => [candidate.code, dividendWeights[index]]),
  ]);
  return { codes: selected.map((candidate) => candidate.code), targetWeights };
}

function buildSelectionDetails(schedules, stockSleeveWeight) {
  return schedules.map((schedule) => {
    const holdings = schedule.codes.map((code) => {
      const candidate = schedule.candidates.find((item) => item.code === code);
      if (!candidate) throw new Error(`${schedule.tradeDate}: missing selected candidate ${code}`);
      return {
        code,
        name: candidate.name,
        targetWeight: schedule.targetWeights?.get(code) ?? stockSleeveWeight / schedule.codes.length,
        style: matchesStyle(candidate, "growth") ? "成长" : matchesStyle(candidate, "dividend") ? "红利" : "—",
        industry: candidate.industry,
        track: candidate.track ?? "未识别",
        institutionCount: candidate.institutionCount,
        previousInstitutionCount: candidate.previousInstitutionCount,
        institutionCountGrowth: candidate.institutionCountGrowth,
        firstInstitutionEntry: candidate.firstInstitutionEntry,
        holdValueRank: candidate.holdValueRank,
        institutionGrowthRank: candidate.institutionGrowthRank,
        compositeScore: candidate.compositeScore,
      };
    });
    if (stockSleeveWeight < 1) {
      holdings.push({
        code: "—",
        name: "防守资产（零收益代理）",
        targetWeight: 1 - stockSleeveWeight,
        style: "防守",
        industry: "—",
        track: "—",
      });
    }
    return { reportDate: schedule.reportDate, tradeDate: schedule.tradeDate, holdings };
  });
}

function matchesStyle(candidate, style) {
  // The existing stock screener uses these current-data cutoffs.  They make the
  // style split reproducible, but are not point-in-time historical classifications.
  if (style === "dividend") return candidate.dividendYield !== null && candidate.dividendYield >= 3;
  return candidate.profitGrowth3Y !== null && candidate.profitGrowth3Y > 15 && !matchesStyle(candidate, "dividend");
}

function bottomMomentumIndustries(candidates, pointByCode, previousDate) {
  const grouped = new Map();
  for (const candidate of candidates) {
    const value = pointByCode.get(candidate.code)?.get(previousDate)?.return63;
    if (!Number.isFinite(value)) continue;
    const values = grouped.get(candidate.industry) ?? [];
    values.push(value);
    grouped.set(candidate.industry, values);
  }
  const ranked = [...grouped.entries()]
    .map(([industry, values]) => ({ industry, score: average(values) }))
    .sort((a, b) => a.score - b.score || a.industry.localeCompare(b.industry));
  return new Set(ranked.slice(0, Math.floor(ranked.length / 4)).map((item) => item.industry));
}

function isAiConcept(candidate) {
  return candidate.concepts.some((concept) => /AI|人工智能|算力|CPO|数据中心|光通信模块/i.test(concept));
}

function previousTradingDate(dates, date) {
  const index = dates.indexOf(date);
  return index > 0 ? dates[index - 1] : null;
}

function runBacktest({ strategy, dates, scheduleByDate, pointByCode, metadataByCode, oneWayCost: cost, recentFrom, stockSleeveWeight }) {
  let cash = 1;
  let shares = new Map();
  let selected = [];
  let turnover = 0;
  let totalCosts = 0;
  let signalChanges = 0;
  let concentrationRebalances = 0;
  let previousSignals = new Map();
  const curve = [];

  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    const previousDate = dates[index - 1] ?? null;
    const schedule = scheduleByDate.get(date);
    if (schedule) {
      selected = schedule.codes;
      previousSignals = new Map();
      const rebalanced = rebalance({
        cash, shares, selected, targetWeights: schedule.targetWeights, date, previousDate, strategy, pointByCode, cost, turnover, totalCosts, stockSleeveWeight,
      });
      ({ cash, shares, turnover, totalCosts } = rebalanced);
      previousSignals = rebalanced.signals;
    } else if (selected.length > 0 && previousDate) {
      const changes = [];
      for (const code of selected) {
        const signal = isInvested(strategy.signal, pointByCode.get(code)?.get(previousDate), previousSignals.get(code));
        const before = previousSignals.get(code);
        if (signal !== null) {
          previousSignals.set(code, signal);
          if (before !== undefined && before !== signal) {
            changes.push([code, signal]);
            signalChanges += 1;
          }
        }
      }
      ({ cash, shares, turnover, totalCosts } = applyChanges({
        cash, shares, changes, strategy, pointByCode, date, selectedCount: selected.length, cost, turnover, totalCosts,
      }));
    }
    if (strategy.concentrationRules && selected.length > 0) {
      const trimmed = applyConcentrationRules({
        cash, shares, date, pointByCode, metadataByCode, cost, turnover, totalCosts, enforceEntryLimits: Boolean(schedule),
      });
      ({ cash, shares, turnover, totalCosts } = trimmed);
      concentrationRebalances += trimmed.events;
    }
    const nav = portfolioValue(cash, shares, pointByCode, date);
    curve.push({ date, nav, stockExposure: exposure(shares, nav, pointByCode, date) });
  }
  return { ...summarize(strategy, curve, turnover, totalCosts, signalChanges, selected.length, recentFrom), concentrationRebalances };
}

function rebalance({ cash, shares, selected, targetWeights, date, previousDate, strategy, pointByCode, cost, turnover, totalCosts, stockSleeveWeight }) {
  const navBefore = portfolioValue(cash, shares, pointByCode, date);
  for (const [code, quantity] of shares) {
    const price = pointByCode.get(code)?.get(date)?.close;
    if (!price) continue;
    const gross = quantity * price;
    cash += gross * (1 - cost);
    turnover += gross / Math.max(navBefore, Number.EPSILON);
    totalCosts += gross * cost;
    shares.delete(code);
  }
  const targetNav = portfolioValue(cash, shares, pointByCode, date);
  const desired = [];
  const signals = new Map();
  for (const code of selected) {
    const signal = isInvested(strategy.signal, pointByCode.get(code)?.get(previousDate), undefined);
    const invested = signal ?? false;
    signals.set(code, invested);
    desired.push([code, invested ? 1 : (strategy.riskWeight ?? 0)]);
  }
  for (const [code, scale] of desired) {
    const price = pointByCode.get(code)?.get(date)?.close;
    if (!price || cash <= 0) continue;
    const targetWeight = targetWeights?.get(code) ?? stockSleeveWeight / selected.length;
    const gross = Math.min(targetNav * targetWeight * scale / (1 + cost), cash / (1 + cost));
    if (gross <= 0) continue;
    shares.set(code, gross / price);
    cash -= gross * (1 + cost);
    turnover += gross / Math.max(targetNav, Number.EPSILON);
    totalCosts += gross * cost;
  }
  // The signal map is attached to the shares object only for this function's caller.
  // It is reconstructed from the prior-day data on the next loop; no future prices leak in.
  return { cash, shares, turnover, totalCosts, signals };
}

function applyChanges({ cash, shares, changes, strategy, pointByCode, date, selectedCount, cost, turnover, totalCosts }) {
  const navBefore = portfolioValue(cash, shares, pointByCode, date);
  for (const [code, invested] of changes) {
    const price = pointByCode.get(code)?.get(date)?.close;
    if (!price) continue;
    const currentGross = (shares.get(code) ?? 0) * price;
    const targetGross = navBefore / selectedCount * (invested ? 1 : (strategy.riskWeight ?? 0)) / (1 + cost);
    const sellGross = Math.max(0, currentGross - targetGross);
    if (sellGross <= 0) continue;
    cash += sellGross * (1 - cost);
    shares.set(code, (currentGross - sellGross) / price);
    if (currentGross - sellGross < 1e-12) shares.delete(code);
    turnover += sellGross / Math.max(navBefore, Number.EPSILON);
    totalCosts += sellGross * cost;
  }
  let nav = portfolioValue(cash, shares, pointByCode, date);
  for (const [code, invested] of changes) {
    const price = pointByCode.get(code)?.get(date)?.close;
    if (!price) continue;
    const currentGross = (shares.get(code) ?? 0) * price;
    const targetGross = nav / selectedCount * (invested ? 1 : (strategy.riskWeight ?? 0)) / (1 + cost);
    const buyGross = Math.min(Math.max(0, targetGross - currentGross), cash / (1 + cost));
    if (buyGross <= 0) continue;
    shares.set(code, (currentGross + buyGross) / price);
    cash -= buyGross * (1 + cost);
    turnover += buyGross / Math.max(nav, Number.EPSILON);
    totalCosts += buyGross * cost;
    nav = portfolioValue(cash, shares, pointByCode, date);
  }
  return { cash, shares, turnover, totalCosts };
}

function applyConcentrationRules({ cash, shares, date, pointByCode, metadataByCode, cost, turnover, totalCosts, enforceEntryLimits }) {
  const limits = enforceEntryLimits
    ? { stock: [0.15, 0.15], track: [0.20, 0.20], industry: [0.25, 0.25] }
    : { stock: [0.20, 0.15], track: [0.25, 0.20], industry: [0.30, 0.25] };
  let events = 0;
  for (const [kind, [trigger, target]] of Object.entries(limits)) {
    const grouped = new Map();
    for (const [code, quantity] of shares) {
      const metadata = metadataByCode.get(code);
      const group = kind === "stock" ? code : metadata?.[kind];
      if (!group) continue;
      const price = pointByCode.get(code)?.get(date)?.close;
      if (!price) continue;
      const entries = grouped.get(group) ?? [];
      entries.push([code, quantity, price]);
      grouped.set(group, entries);
    }
    for (const entries of grouped.values()) {
      const navBefore = portfolioValue(cash, shares, pointByCode, date);
      const gross = entries.reduce((sum, [, quantity, price]) => sum + quantity * price, 0);
      if (gross / Math.max(navBefore, Number.EPSILON) <= trigger) continue;
      const sellGross = (gross - target * navBefore) / (1 - target * cost);
      if (sellGross <= 0) continue;
      for (const [code, quantity, price] of entries) {
        const part = sellGross * (quantity * price / gross);
        const remaining = Math.max(0, quantity - part / price);
        if (remaining < 1e-12) shares.delete(code);
        else shares.set(code, remaining);
      }
      cash += sellGross * (1 - cost);
      turnover += sellGross / Math.max(navBefore, Number.EPSILON);
      totalCosts += sellGross * cost;
      events += 1;
    }
  }
  return { cash, shares, turnover, totalCosts, events };
}

function isInvested(kind, point, previous) {
  if (kind === "always") return true;
  if (!point?.ma20 || !point?.ma60 || !point?.high60) return null;
  if (kind === "ma20") return point.close >= point.ma20;
  if (kind === "ma60") return point.close >= point.ma60;
  if (kind === "ma60-buffer") {
    if (point.close < point.ma60 * 0.98) return false;
    if (point.close > point.ma60 * 1.02) return true;
    return previous ?? point.close >= point.ma60;
  }
  const dual = point.close >= point.ma60 && point.ma20 >= point.ma60;
  if (kind === "dual-ma") return dual;
  const threshold = kind === "dd15-dual" ? 0.85 : 0.80;
  return dual && point.close / point.high60 > threshold;
}

function portfolioValue(cash, shares, pointByCode, date) {
  let value = cash;
  for (const [code, quantity] of shares) {
    const price = pointByCode.get(code)?.get(date)?.close;
    if (price) value += quantity * price;
  }
  return value;
}

function exposure(shares, nav, pointByCode, date) {
  if (!nav) return 0;
  let value = 0;
  for (const [code, quantity] of shares) value += quantity * (pointByCode.get(code)?.get(date)?.close ?? 0);
  return value / nav;
}

function summarize(strategy, curve, turnover, totalCosts, signalChanges, selectedCount, recentFrom) {
  const overall = summarizeCurve(curve);
  const recentCurve = recentFrom ? curve.filter((point) => point.date >= recentFrom) : [];
  const recent = recentCurve.length >= 2 ? summarizeCurve(recentCurve) : null;
  return {
    ...strategy,
    ...overall,
    recent,
    turnover,
    totalCosts,
    signalChanges,
    averageExposure: curve.reduce((sum, point) => sum + point.stockExposure, 0) / curve.length,
    endingNav: curve.at(-1).nav,
    selectedCount,
  };
}

function summarizeCurve(curve) {
  const peak = { value: 0 };
  let maxDrawdown = 0;
  for (const point of curve) {
    peak.value = Math.max(peak.value, point.nav);
    maxDrawdown = Math.min(maxDrawdown, point.nav / peak.value - 1);
  }
  const start = curve[0].nav;
  const end = curve.at(-1).nav;
  const years = Math.max((curve.length - 1) / 252, 1 / 252);
  const returns = curve.slice(1).map((point, index) => point.nav / curve[index].nav - 1);
  const volatility = standardDeviation(returns) * Math.sqrt(252);
  return {
    start: curve[0].date,
    end: curve.at(-1).date,
    cagr: (end / start) ** (1 / years) - 1,
    maxDrawdown,
    volatility,
    calmar: maxDrawdown ? ((end / start) ** (1 / years) - 1) / Math.abs(maxDrawdown) : null,
  };
}

function renderReport(args) {
  if (args.concentrationRules) return renderConcentrationReport(args);
  if (!args.industryExperiments) return renderReportLegacy(args);
  const { to, oneWayCost: cost, universe, schedules, results, industrySnapshot, holdingType } = args;
  const rows = [...results].sort((a, b) => b.calmar - a.calmar);
  const coverage = new Set(schedules.flatMap((schedule) => schedule.candidates.filter((item) => item.industry !== "未分类").map((item) => item.code))).size;
  const holdingLabel = holdingType === "1" ? "基金" : "全机构汇总";
  return `# 机构持仓 Top100：当前行业标签的集中度探索回测

> 生成日期：${new Date().toISOString().slice(0, 10)}；行情截止：${to}；行业分类为运行时查询的最新东财标签，AI 概念标签快照日期为 ${industrySnapshot.dataDate}。本报告是探索性策略研究，不构成投资建议。

## 结果（按全样本 Calmar 排序）

| 组合 | 年化收益 | 年化波动 | 最大回撤 | Calmar | 近一年年化收益 | 近一年最大回撤 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${rows.map((row) => `| ${row.name} | ${pct(row.cagr)} | ${pct(row.volatility)} | ${pct(row.maxDrawdown)} | ${row.calmar.toFixed(2)} | ${pct(row.recent.cagr)} | ${pct(row.recent.maxDrawdown)} |`).join("\n")}

## 组合定义

- 每季按当期${holdingLabel}持仓市值（\`HOLD_VALUE\`）建立点时 Top100 A 股候选池；法定完整披露截止日后的首个交易日换仓，取 20 只等权，单边摩擦 ${Math.round(cost * 10_000)}bp。
- 行业上限以 20 只等权的股数实现：10%/15%/20%/25% 分别是每行业最多 2/3/4/5 只；按 \`HOLD_VALUE\` 从高到低选入，超过上限则跳过。
- “剔除最弱行业”仅用换仓前第 63 个交易日至前一交易日的候选股行业平均收益，剔除当期最弱四分之一行业；没有使用未来行情。
- “Top10行业×各2只”先按该季度各行业候选股 \`HOLD_VALUE\` 合计排序，再在入选行业中按 \`HOLD_VALUE\` 取股，对应10%的行业等权暴露。5行业×4只在2024年一季度基金Top100中仅有4个行业具备4只候选，无法形成完整20只组合，故不把放松后的结果混入比较。
- “剔除当前 AI 概念股”以 ${industrySnapshot.dataDate} 快照中的概念含 \`AI\`、\`人工智能\`、\`算力\`、\`CPO\`、\`数据中心\` 或 \`光通信模块\` 判定；它和当前行业标签一样含前视信息，只用于解释 AI 集中度敏感性，不能作为可交易结论。

${renderSelectionDetails(results)}

## 关键限制

- ${universe} 只历史候选股票中，${coverage} 只可由运行时查询的最新行业标签映射，另1只使用当前快照回退。将今天的标签施加于 2024--2026 历史成分是前视偏差；因此本报告只能帮助比较“若按今天分类管理会怎样”，不能据此确定正式行业上限。
- 近一年列为 ${rows[0].recent.start} 至 ${rows[0].recent.end}；它专门检验近期 AI 强势是否主导全样本结论，不能与完整周期等量看待。
- AI 概念快照仅覆盖当前Top300；未被标记不能证明不是AI暴露，因此“剔除AI”只表示一个保守的敏感性测试。
- 未模拟停牌、涨跌停、冲击成本、税费差异和容量约束；也没有按行业作收益优化后再回看选取最优参数。
`;
}

function renderConcentrationReport({ to, results, holdingType, industrySnapshot, stockSleeveWeight, maxConcentrationInitial, institutionCountGrowth, institutionGrowthWeight }) {
  const holdingLabel = holdingType === "1" ? "基金" : "全机构汇总";
  const allocations = [...new Map(results.filter((row) => row.variant.styleAllocation).map((row) => [row.variant.id, row.variant.styleAllocation])).values()];
  const portfolioLabel = maxConcentrationInitial ? `基金持仓：成长50%/红利20%的${allocations.map((item) => item.stockCount).join("、")}股集中度规则回测` : "基金Top20：个人集中度规则最近一年回测";
  const construction = maxConcentrationInitial
    ? `每季在当期${holdingLabel}持仓市值（\`HOLD_VALUE\`）Top100候选中，分别按成长/红利数量选股：${allocations.map((item) => `${item.stockCount}股为成长${item.growthCount}只、红利${item.dividendCount}只`).join("；")}。${institutionCountGrowth ? `候选综合当前 \`HOLD_VALUE\` 名次与相对上一报告期的持仓机构数（\`HOULD_NUM\`）增量名次：二者分别线性归一化为0--1分，持仓市值占${((1 - institutionGrowthWeight) * 100).toFixed(0)}%、机构数增量占${(institutionGrowthWeight * 100).toFixed(0)}%，综合分从高到低选入；同分时依次比较增量、持仓市值名次和代码。上期机构数从东财该期完整基金持仓记录逐只读取，只有完全不存在记录时才按首次持有的0计算。` : "候选按持仓市值排序。"}每个桶内部按目标权重配置；仅在达到该桶最少持股数时按15%上限优先配置。全部股票行业各不相同、且已识别二级赛道不重复。成长定义为当前3年净利润增长率>15%且股息率<3%，红利定义为当前股息率≥3%。`
    : "每季按当期基金 `HOLD_VALUE` 取前20只 A 股等权。";
  return `# ${portfolioLabel}

> 行情截止：${to}；行业标签为运行时查询的最新东财分类，主营赛道按 \`web/src/config/institutional-track-taxonomy.json\` 的精确行业映射和公司级校正分类，快照日期为 ${industrySnapshot.dataDate}。本报告是探索性研究，不构成投资建议。

| 组合 | 全样本年化收益 | 全样本最大回撤 | 全样本 Calmar | 近一年年化收益 | 近一年最大回撤 | 集中度再平衡次数 | 成本拖累 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${results.map((row) => `| ${row.name} | ${pct(row.cagr)} | ${pct(row.maxDrawdown)} | ${row.calmar.toFixed(2)} | ${pct(row.recent.cagr)} | ${pct(row.recent.maxDrawdown)} | ${row.concentrationRebalances ?? 0} | ${pct(row.totalCosts)} |`).join("\n")}

## 规则实现

- ${construction}法定披露截止日后的首个交易日换仓，股票篮子占总资产 ${(stockSleeveWeight * 100).toFixed(0)}%，其余 ${(100 - stockSleeveWeight * 100).toFixed(0)}%以零收益防守资产代理，单边成本15bp。
- 建仓/换仓日：单股、二级赛道、行业分别不得超过15%/20%/25%；超过部分卖出为现金，不补到其他股票。
- 持有期：对应权重超过20%/25%/30%时，将该层分别减回15%/20%/25%；按单股→赛道→行业顺序执行。价格上涨或其他资产下跌导致的15%/20%/25%被动越线，在未超过再平衡线前不卖。
- 主营赛道来自当前精确行业映射和公司级校正，主题概念不参与分类；当前分类回填历史仍含前视偏差。新增未映射行业会直接报错，不会静默跳过赛道上限。
${institutionCountGrowth ? "- `首次持有`表示东财完整上期基金持仓记录中没有该股票，而非仅仅上期未进入Top100；本策略不会把名单外的缺失值直接视为0。机构数增量可以为负；只要当前持仓市值排名足够高，仍可因综合分入选。" : ""}

${renderSelectionDetails(results)}
`;
}

function renderReportLegacy({ baseUrl, from, to, oneWayCost: cost, universe, schedules, results }) {
  const rows = [...results].sort((a, b) => b.calmar - a.calmar);
  return `# 机构持仓 Top100：个股风控规则回测（初步）\n\n> 生成日期：${new Date().toISOString().slice(0, 10)}；行情截止：${to}。本报告是策略研究，不构成投资建议。\n\n## 回测结论\n\n以下结果只适用于本定义的、滚动机构持仓 Top100 等权股票篮子；不能直接外推到单一个股，更不能保证未来收益或回撤。按回撤收益比（Calmar）排序的候选中，应优先比较换手、持仓暴露和执行难度，而不是只选择历史数值最高者。\n\n| 规则 | 年化收益 | 年化波动 | 最大回撤 | Calmar | 平均股票暴露 | 累计换手 | 信号切换 | 成本拖累 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.map((row) => `| ${row.name} | ${pct(row.cagr)} | ${pct(row.volatility)} | ${pct(row.maxDrawdown)} | ${row.calmar.toFixed(2)} | ${pct(row.averageExposure)} | ${(row.turnover * 100).toFixed(1)}% | ${row.signalChanges} | ${pct(row.totalCosts)} |`).join("\n")}\n\n## 固定的策略定义\n\n- 每季按全机构汇总持仓市值（\`HOLD_VALUE\`）取前100只 A 股，等权配置；持仓榜在可获得日期后才换仓。报告披露可用日采用保守的完整报告截止日：一季报后5月1日、中报后9月1日、三季报后11月1日、年报后次年4月1日，再取其后的首个交易日。\n- 信号仅使用**前一交易日**前复权收盘价，交易记在下一交易日收盘；不存在用当天收盘价产生信号、再以同一收盘价成交的前视偏差。\n- 卖出的资金留为现金，未把它重新加到仍在持有的股票；重新转强时只恢复该股票约1%的初始等权仓。现金收益记为0%，因此并未把货币基金收益算入风控策略。\n- 每笔买卖假定单边总摩擦 ${Math.round(cost * 10_000)}bp（佣金、印花税和滑点的简化合并假设）；没有模拟涨跌停、停牌无法成交、冲击成本和个股最低佣金。\n- MA20、MA60、60日高点均按各股票自身前复权收盘价计算。双均线“转空”为收盘低于MA60且MA20低于MA60；恢复要求二者同时重新转多。\n\n${renderSelectionDetails(results)}\n\n## 样本与限制\n\n- 成分股报告期：${schedules.map((item) => item.reportDate).join("、")}；形成日期：${schedules.map((item) => item.tradeDate).join("、")}。实际策略样本为 ${results[0].start} 至 ${results[0].end}，仅约两年多，包含的完整熊市/牛市周期有限。\n- 历史成分股有 ${universe} 只不同股票，使用东方财富经 \`${baseUrl}\` 转发的日线前复权价格。此设计避免使用今天的Top100回看过去的主要幸存者偏差，但不能消除季度披露滞后、数据修订及前复权口径的局限。\n- 这是“机构重仓个股篮子”的组合规则，不是对基本面已证伪、财务造假、连续跌停等事件的替代。此类事件仍须走基本面紧急退出规则。\n- 先在这个预先定义的规则集合中比较，再做未来新季度的走样本外跟踪；不要因回测中某个参数最好而继续细调到历史最优。\n\n## 数据来源\n\n- 机构持仓：东方财富 \`/api/companies/holding/rank\`，\`type=0\`、\`rank=HOLD_VALUE\`，每个报告期前两页。\n- 行情：东方财富日线前复权，\`/api/kline?period=day&fq=qfq\`。\n`;
}

function renderSelectionDetails(results) {
  const selections = new Map();
  for (const result of results) {
    const key = `${result.variant.id}:${result.portfolioSize}`;
    if (!selections.has(key)) selections.set(key, { name: result.variant.name, details: result.selectionDetails });
  }
  return `## 每季选股与资产明细\n\n${[...selections.values()].map(({ name, details }) => `### ${name}\n\n${details.map((schedule) => `#### 报告期 ${schedule.reportDate}；换仓日 ${schedule.tradeDate}\n\n| 代码 | 标的 | 初始目标权重 | 风格代理 | 行业 | 二级赛道 | HOLD_VALUE名次 | 机构数（本期/上期/增量） | 增量名次 | 综合分 |\n| --- | --- | ---: | --- | --- | --- | ---: | --- | ---: | ---: |\n${schedule.holdings.map((holding) => `| ${holding.code} | ${holding.name} | ${pct(holding.targetWeight)} | ${holding.style} | ${holding.industry} | ${holding.track} | ${formatRank(holding.holdValueRank)} | ${formatInstitutionCountChange(holding)} | ${formatRank(holding.institutionGrowthRank)} | ${formatScore(holding.compositeScore)} |`).join("\n")}`).join("\n\n")}`).join("\n\n")}`;
}

function formatInstitutionCountChange(holding) {
  if (!Number.isFinite(holding.institutionCountGrowth)) return "—";
  return `${holding.institutionCount} / ${holding.previousInstitutionCount} / ${holding.institutionCountGrowth >= 0 ? "+" : ""}${holding.institutionCountGrowth}${holding.firstInstitutionEntry ? "（首次持有）" : ""}`;
}

function formatRank(value) { return Number.isInteger(value) ? String(value) : "—"; }
function formatScore(value) { return Number.isFinite(value) ? value.toFixed(3) : "—"; }

function availabilityDate(reportDate) {
  const [year, month] = reportDate.split("-").map(Number);
  if (month === 3) return `${year}-05-01`;
  if (month === 6) return `${year}-09-01`;
  if (month === 9) return `${year}-11-01`;
  return `${year + 1}-04-01`;
}

function previousQuarterEnd(reportDate) {
  const [year, month] = reportDate.split("-").map(Number);
  if (month === 3) return `${year - 1}-12-31`;
  if (month === 6) return `${year}-03-31`;
  if (month === 9) return `${year}-06-30`;
  return `${year}-09-30`;
}

function quarterEndsBetween(start, end) {
  const dates = [];
  for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year += 1) {
    for (const tail of ["03-31", "06-30", "09-30", "12-31"]) {
      const date = `${year}-${tail}`;
      if (date >= start && date <= end) dates.push(date);
    }
  }
  return dates;
}

function nextTradingDate(dates, availableDate) { return dates.find((date) => date >= availableDate) ?? null; }
function average(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function numberOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}
function pct(value) { return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`; }
function parsePortfolioSizes(value) {
  const sizes = String(value).split(",").map((item) => Number(item.trim()));
  if (!sizes.length || sizes.some((size) => !Number.isInteger(size) || size < 2 || size > 100)) throw new Error("--portfolio-sizes must be comma-separated integers from 2 to 100");
  return [...new Set(sizes)].sort((a, b) => a - b);
}
function parseStyleStockCounts(value) {
  const sizes = String(value).split(",").map((item) => Number(item.trim()));
  if (!sizes.length || sizes.some((size) => !Number.isInteger(size) || size < 6 || size > 100)) throw new Error("--initial-stock-counts must be comma-separated integers from 6 to 100");
  return [...new Set(sizes)].sort((a, b) => a - b);
}

async function fetchJson(base, pathname, params) {
  const url = new URL(pathname, base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
      const body = await response.json();
      if (!response.ok || body.code !== 200 || !Array.isArray(body.data)) throw new Error(`${response.status} ${url}`);
      return body.data;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function fetchJsonObject(base, pathname, params) {
  const url = new URL(pathname, base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
      const body = await response.json();
      if (!response.ok || body.code !== 200 || !body.data || typeof body.data !== "object") throw new Error(`${response.status} ${url}`);
      return body.data;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function mapConcurrent(items, concurrency, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await mapper(items[index], index);
    }
  }));
  return result;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) throw new Error(`unexpected argument: ${values[index]}`);
    parsed[values[index].slice(2)] = values[++index];
  }
  return parsed;
}
