#!/usr/bin/env node
/**
 * Diagnostic screen using Xueqiu quotes.
 *
 * Runs the native valuation screen on daily Xueqiu observations without
 * changing configuration, providers, prices or the active dashboard. The
 * daily market capitalization and PE are read from the existing Xueqiu API.
 * This is an offline research diagnostic, not an automatic provider fallback.
 *
 * Read-only. No price is emitted, no target, no instruction.
 *
 * Usage:
 *   node scripts/screen-with-xueqiu-quotes.mjs
 *   node scripts/screen-with-xueqiu-quotes.mjs --json
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { screenValuationCandidate } from './lib/rust-analysis.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const inline = args.find((item) => item.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const asJson = args.includes("--json");
/**
 * Disable the growth veto, for an honest before/after comparison.
 *
 * Without this flag the only way to say "the veto removed N candidates" would
 * be to compare two runs made on different quote sources, which measures the
 * source as much as the rule.  With both runs on the same quotes, the
 * difference is attributable to the veto alone.
 */
const ignoreGrowth = args.includes("--no-growth");
const baseUrl = option("--base-url", "http://127.0.0.1:8000").replace(/\/+$/, "");
const concurrency = Math.max(1, Number(option("--concurrency", "4")) || 4);
const market = option("--market", "");

const universe = JSON.parse(readFileSync(resolve(root, "config/investment-universe.json"), "utf8"));
const apiCodeFor = (security) => (security.market === "US" && !security.ticker.endsWith(".US")
  ? `${security.ticker}.US`
  : security.ticker);

const targets = universe.companies
  .filter((company) => company.classificationStatus === "verified")
  .filter((company) => !market || company.preferredMarket === market)
  .map((company) => {
    const security = company.securities.find((item) => item.ticker === company.preferredTicker) ?? company.securities[0];
    return { name: company.displayName, code: apiCodeFor(security), market: security.market };
  });

async function getJson(path) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(180_000) });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.code === 200) return body.data;
    } catch {
      // retried below
    }
    await new Promise((done) => setTimeout(done, 1200 * (attempt + 1)));
  }
  return null;
}

function tradingCurrency(targetMarket) {
  return targetMarket === "CN" ? "CNY" : targetMarket === "HK" ? "HKD" : targetMarket === "US" ? "USD" : null;
}

/**
 * Reporting currency of the newest *formal* statement (see the production script
 * for why `rows[0]` is wrong: a forecast row carries no currency field).
 */
async function reportingCurrency(code) {
  const rows = await getJson(`/api/finance/income?code=${encodeURIComponent(code)}`);
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const currency = row?.REPORTING_CURRENCY ?? row?.CURRENCY;
    if (typeof currency === "string" && currency.trim()) return currency.trim();
  }
  return null;
}

/**
 * Latest Xueqiu quote: market cap and the session it belongs to.
 *
 * A-shares carry `marketCapital` on the K-line.  Hong Kong and US rows do not —
 * Xueqiu omits it for those markets — so the cap is derived from the daily PE
 * and the TTM net profit the same response is paired with.  That is not a
 * fallback for production, where the report currency and the trading currency
 * can differ (阿里 reports CNY, trades HKD) and the screen blocks on that
 * mismatch; this is a diagnostic that already blocks those cases via the
 * currency gate.
 */
async function xueqiuQuote(code, ttmNetProfit) {
  const rows = await getJson(`/api/kline?code=${encodeURIComponent(code)}&period=day&format=structured&from=2026-09-01`);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  const direct = typeof last.marketCapital === "number" && last.marketCapital > 0 ? last.marketCapital : null;
  if (direct !== null) return { currency: null, priceAsOf: last.date ?? null, marketCap: direct };
  const pe = typeof last.peTtm === "number" && last.peTtm > 0 ? last.peTtm : null;
  if (pe === null || typeof ttmNetProfit !== "number" || ttmNetProfit <= 0) return null;
  return { currency: null, priceAsOf: last.date ?? null, marketCap: pe * ttmNetProfit, derived: true };
}

/** Trailing net-profit growth from the newest quarterly/interim period. */
function ttmGrowth(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const latest = points[0];
  const latestDate = Date.parse(`${latest?.reportDate}T00:00:00Z`);
  if (!Number.isFinite(latestDate)) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const point of points.slice(1)) {
    const time = Date.parse(`${point?.reportDate}T00:00:00Z`);
    if (!Number.isFinite(time)) continue;
    const distance = Math.abs(time - (latestDate - 365 * 86_400_000));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  if (!best || bestDistance > 45 * 86_400_000) return null;
  const now = latest?.ttmNetProfit;
  const then = best?.ttmNetProfit;
  if (typeof now !== "number" || typeof then !== "number" || then <= 0 || now <= 0) return null;
  return { ttmGrowth: now / then - 1, reportDate: latest.reportDate, provisional: latest.provisional === true };
}

async function growthReading(code) {
  const data = await getJson(`/api/finance/income/quarterly-series?code=${encodeURIComponent(code)}&limit=8`);
  const points = data?.points ?? [];
  const latest = points[0] ?? null;
  return {
    growth: ttmGrowth(points),
    ttmNetProfit: typeof latest?.ttmNetProfit === "number" ? latest.ttmNetProfit : null,
  };
}

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < targets.length) {
    const target = targets[cursor++];
    try {
      const [bands, bandCurrency, growthInfo] = await Promise.all([
        getJson(`/api/finance/valuation-bands?code=${encodeURIComponent(target.code)}`),
        reportingCurrency(target.code),
        growthReading(target.code),
      ]);
      const quote = await xueqiuQuote(target.code, growthInfo.ttmNetProfit);
      const growth = growthInfo.growth;
      if (!bands) {
        results.push({ code: target.code, name: target.name, market: target.market, verdict: "blocked", blockReasons: ["bands_unavailable"], note: "区间接口未返回数据" });
        continue;
      }
      if (!quote) {
        results.push({ code: target.code, name: target.name, market: target.market, verdict: "blocked", blockReasons: ["quote_missing"], note: "雪球无市值，且无 PE 与 TTM 净利润可反推" });
        continue;
      }
      const result = screenValuationCandidate({
        code: target.code,
        archetype: bands.archetype,
        bands: bands.bands,
        bandCurrency,
        quote: { currency: tradingCurrency(target.market), priceAsOf: quote.priceAsOf, marketCap: quote.marketCap },
        growth: ignoreGrowth ? null : growth,
      });
      results.push({ ...result, name: target.name, market: target.market, bandCurrency });
    } catch (error) {
      results.push({ code: target.code, name: target.name, market: target.market, verdict: "blocked", blockReasons: ["request_failed"], note: error instanceof Error ? error.message : String(error) });
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

const byVerdict = results.reduce((acc, item) => { acc[item.verdict] = (acc[item.verdict] ?? 0) + 1; return acc; }, {});
const blockedDetail = results
  .filter((item) => item.verdict === "blocked")
  .reduce((acc, item) => { for (const reason of item.blockReasons) acc[reason] = (acc[reason] ?? 0) + 1; return acc; }, {});
const growthDetail = results.reduce((acc, item) => {
  const verdict = item.growth?.verdict ?? "unknown";
  acc[verdict] = (acc[verdict] ?? 0) + 1;
  return acc;
}, {});

if (asJson) {
  console.log(JSON.stringify({ screened: results.length, byVerdict, blockedDetail, growthDetail, results }, null, 2));
  process.exit(0);
}

console.log(`Diagnostic screen (Xueqiu quotes) — ${results.length} companies`);
console.log(`Verdicts: ${JSON.stringify(byVerdict)}`);
console.log(`Growth:   ${JSON.stringify(growthDetail)}`);
if (Object.keys(blockedDetail).length) console.log(`Blocked:  ${JSON.stringify(blockedDetail)}`);
console.log("");

const candidates = results.filter((item) => item.verdict === "research_candidate");
if (candidates.length) {
  console.log("research_candidate:");
  for (const item of candidates.sort((left, right) => (right.position?.marginOfSafety ?? 0) - (left.position?.marginOfSafety ?? 0))) {
    const growth = item.growth?.ttmGrowth;
    console.log(
      `  ${item.code.padEnd(11)} ${String(item.name).padEnd(9)} ${String(item.basis?.key).padEnd(10)}`
      + ` 边际 ${((item.position?.marginOfSafety ?? 0) * 100).toFixed(1)}%`
      + `  增速 ${typeof growth === "number" ? `${(growth * 100).toFixed(1)}%` : "—"}`,
    );
  }
  console.log("");
}

const vetoed = results.filter((item) => item.growth?.verdict === "vetoes");
if (vetoed.length) {
  console.log(`Growth veto fired (${vetoed.length}) — profit shrinking ≥15%, multiple not a discount:`);
  for (const item of vetoed) {
    console.log(
      `  ${item.code.padEnd(11)} ${String(item.name).padEnd(9)} ${item.verdict.padEnd(19)}`
      + ` 增速 ${(item.growth.ttmGrowth * 100).toFixed(1)}%`
      + `  ${item.basis ? `${item.basis.key} ${item.basis.range.low}–${item.basis.range.high}` : ""}`,
    );
  }
  console.log("");
}

const weak = results.filter((item) => item.growth?.verdict === "weakens");
if (weak.length) {
  console.log(`Mild shrinkage (${weak.length}): ${weak.map((item) => item.name).join("、")}`);
}
