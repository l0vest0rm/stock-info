#!/usr/bin/env node
/**
 * Does growth actually explain the multiple?
 *
 * The proposal is: choose the PE band from the growth rate, because a 30%
 * grower and a 5% grower cannot deserve the same multiple.  That claim is
 * testable with data the repository already stores — Xueqiu gives a daily PE,
 * and the quarterly-series endpoint gives TTM net profit and its year-ago twin,
 * so for every company we can pair "what the market paid" with "how fast it was
 * actually growing".
 *
 * This script runs that test before anyone changes a band.  It reports:
 *
 *   1. coverage — how many companies have a usable growth figure at all;
 *   2. the cross-sectional relationship — is higher growth associated with a
 *      higher PE, and how much of the spread does growth explain;
 *   3. PEG — PE divided by growth — per archetype, because if growth explains
 *      the multiple, PEG should be more stable across archetypes than PE is.
 *
 * Point 3 is the decisive one.  Raw PE varies 6.9x (banks) to 59x (healthcare);
 * if PEG also varies tenfold across archetypes, then growth does not normalise
 * the multiple and a growth-linked band would just be a relabelled PE band.
 *
 * Read-only. Never writes a band, never emits a target or an instruction.
 *
 * Usage:
 *   node scripts/analyze-growth-vs-multiple.mjs
 *   node scripts/analyze-growth-vs-multiple.mjs --json
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const inline = args.find((item) => item.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const asJson = args.includes("--json");
const baseUrl = option("--base-url", "http://127.0.0.1:8000").replace(/\/+$/, "");
const concurrency = Math.max(1, Number(option("--concurrency", "5")) || 5);

const universe = JSON.parse(readFileSync(resolve(root, "config/investment-universe.json"), "utf8"));

const apiCodeFor = (security) => (security.market === "US" && !security.ticker.endsWith(".US")
  ? `${security.ticker}.US`
  : security.ticker);

const targets = universe.companies
  .filter((company) => company.classificationStatus === "verified")
  .map((company) => {
    const security = company.securities.find((item) => item.ticker === company.preferredTicker) ?? company.securities[0];
    return {
      name: company.displayName,
      code: apiCodeFor(security),
      market: security.market,
      archetype: company.valuationArchetype ?? "other",
    };
  });

async function getJson(path) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(180_000) });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.code === 200) return body.data;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((done) => setTimeout(done, 1200 * (attempt + 1)));
  }
  void lastError;
  return null;
}

/**
 * TTM net-profit growth, year over year.
 *
 * `ttmNetProfit` at each report date is a rolling twelve-month figure, so
 * comparing it with the same quarter a year earlier gives growth that is not
 * distorted by seasonality.  A single quarter's YoY is available too and is
 * fresher, but it swings on one quarter's mix; the TTM comparison is the one
 * that can be paired with a TTM PE without mixing horizons.
 *
 * The year-ago point is found by date, not by array position: a US filer
 * reports 12M and 3M rows interleaved, so index 4 is not reliably four
 * quarters back.
 */
function ttmGrowth(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const latest = points[0];
  const latestDate = Date.parse(`${latest?.reportDate}T00:00:00Z`);
  if (!Number.isFinite(latestDate)) return null;
  const targetTime = latestDate - 365 * 86_400_000;
  let best = null;
  let bestDistance = Infinity;
  for (const point of points.slice(1)) {
    const time = Date.parse(`${point?.reportDate}T00:00:00Z`);
    if (!Number.isFinite(time)) continue;
    const distance = Math.abs(time - targetTime);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  // Reject a "year ago" that is more than six weeks off the anniversary: that is
  // a different period, and dividing by it would mix horizons.
  if (!best || bestDistance > 45 * 86_400_000) return null;
  const now = latest?.ttmNetProfit;
  const then = best?.ttmNetProfit;
  if (typeof now !== "number" || typeof then !== "number") return null;
  if (!Number.isFinite(now) || !Number.isFinite(then) || then <= 0 || now <= 0) return null;
  return { growth: now / then - 1, yearAgoDate: best.reportDate };
}

/**
 * Latest quote, from the Xueqiu K-line.
 *
 * The Eastmoney `push2delay` quote endpoint fails intermittently on this host
 * (IPv6 reset), and a run that silently drops a third of the pool would
 * misreport the coverage.  Xueqiu's K-line carries both the daily PE and the
 * market capitalisation, so the multiple side comes from one source that works.
 */
async function latestQuote(code) {
  const rows = await getJson(`/api/kline?code=${encodeURIComponent(code)}&period=day&format=structured&from=2026-09-01`);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  return {
    date: last.date ?? null,
    pe: typeof last.peTtm === "number" && last.peTtm > 0 ? last.peTtm : null,
    pb: typeof last.pb === "number" && last.pb > 0 ? last.pb : null,
    marketCap: typeof last.marketCapital === "number" && last.marketCapital > 0 ? last.marketCapital : null,
  };
}

async function collect(target) {
  const [quarterly, quote] = await Promise.all([
    getJson(`/api/finance/income/quarterly-series?code=${encodeURIComponent(target.code)}&limit=8`),
    latestQuote(target.code),
  ]);
  const points = quarterly?.points ?? [];
  const latestPoint = points[0] ?? null;
  const growth = ttmGrowth(points);
  const growthTtm = growth ? growth.growth : null;
  const growthSingleQuarter = typeof latestPoint?.netProfitYoY === "number" ? latestPoint.netProfitYoY : null;
  const growthCumulative = typeof latestPoint?.revenueYoY === "number" ? latestPoint.revenueYoY : null;

  const ttmNetProfit = typeof latestPoint?.ttmNetProfit === "number" ? latestPoint.ttmNetProfit : null;

  return {
    ...target,
    reportDate: latestPoint?.reportDate ?? null,
    yearAgoReportDate: growth ? growth.yearAgoDate : null,
    provisional: latestPoint?.provisional ?? null,
    ttmNetProfit,
    marketCap: quote?.marketCap ?? null,
    pe: quote?.pe ?? null,
    pb: quote?.pb ?? null,
    quoteDate: quote?.date ?? null,
    growthTtm,
    growthSingleQuarter,
    growthCumulative,
  };
}

let cursor = 0;
const rows = [];
async function worker() {
  for (;;) {
    const index = cursor++;
    if (index >= targets.length) return;
    try {
      rows.push(await collect(targets[index]));
    } catch {
      rows.push({ ...targets[index], error: true });
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
rows.sort((left, right) => left.code.localeCompare(right.code));

// ---------------------------------------------------------------- statistics
const withGrowth = rows.filter((row) => typeof row.growthTtm === "number" && typeof row.pe === "number");

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
/** Pearson correlation; both inputs must be the same length. */
function correlation(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}
/** Ordinary least squares slope and intercept of y on x. */
function regress(xs, ys) {
  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

const growths = withGrowth.map((row) => row.growthTtm);
const pes = withGrowth.map((row) => row.pe);
const logPes = pes.map((value) => Math.log(value));
const peg = withGrowth
  .filter((row) => row.growthTtm > 0)
  .map((row) => ({ ...row, peg: row.pe / (row.growthTtm * 100) }));

const corrLevel = correlation(growths, pes);
const corrLog = correlation(growths, logPes);
const fit = regress(growths, logPes);

// ------------------------------------------------------------- per archetype
const byArchetype = new Map();
for (const row of rows) {
  if (!byArchetype.has(row.archetype)) byArchetype.set(row.archetype, []);
  byArchetype.get(row.archetype).push(row);
}

const archetypes = [...byArchetype.entries()]
  .sort((left, right) => left[0].localeCompare(right[0]))
  .map(([archetype, members]) => {
    const usable = members.filter((row) => typeof row.growthTtm === "number" && typeof row.pe === "number");
    const pegs = usable.filter((row) => row.growthTtm > 0).map((row) => row.pe / (row.growthTtm * 100));
    return {
      archetype,
      companies: members.length,
      withGrowth: usable.length,
      medianPe: median(usable.map((row) => row.pe)),
      medianGrowthPct: median(usable.map((row) => row.growthTtm * 100)),
      medianPeg: median(pegs),
      pegSamples: pegs.length,
    };
  });

/**
 * Growth-bucketed median PE, the robust version of the cross-sectional test.
 *
 * A single Pearson coefficient over 90 companies is dominated by a handful of
 * extreme growth readings — 拉卡拉's TTM growth is over 400% off a depressed
 * base, and one such point moves the coefficient more than fifty normal ones.
 * Bucketing by growth and reporting the median PE in each bucket asks the same
 * question without giving any single company that leverage.
 */
const BUCKET_EDGES_PCT = [-100, 0, 10, 20, 35, 1000];
function growthBuckets(list) {
  return BUCKET_EDGES_PCT.slice(0, -1).map((lower, index) => {
    const upper = BUCKET_EDGES_PCT[index + 1];
    const members = list.filter((row) => {
      const pct = row.growthTtm * 100;
      return pct >= lower && pct < upper;
    });
    return {
      label: `${lower}% … ${upper === 1000 ? "∞" : `${upper}%`}`,
      n: members.length,
      medianPe: median(members.map((row) => row.pe)),
      medianGrowthPct: median(members.map((row) => row.growthTtm * 100)),
    };
  });
}
const buckets = growthBuckets(withGrowth);

if (asJson) {
  console.log(JSON.stringify({
    asOf: new Date().toISOString().slice(0, 10),
    companies: rows.length,
    withGrowth: withGrowth.length,
    correlationGrowthVsPe: corrLevel,
    correlationGrowthVsLogPe: corrLog,
    logPeOnGrowth: fit,
    growthBuckets: buckets,
    archetypes,
    rows,
  }, null, 2));
  process.exit(0);
}

const fmt = (value, digits = 2) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—");
const pct = (value) => (typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—");

console.log("Does growth explain the multiple?");
console.log("");
console.log(`Companies: ${rows.length}   usable (TTM growth + PE): ${withGrowth.length}`);
console.log("");

const missing = rows.filter((row) => typeof row.growthTtm !== "number");
console.log(`No TTM growth (${missing.length}):`);
for (const row of missing.slice(0, 20)) {
  const reason = row.pe === null ? "no PE" : "no year-ago TTM profit";
  console.log(`  ${row.code.padEnd(11)} ${row.name}  ${reason}`);
}
console.log("");

console.log("Cross-sectional relationship, all usable companies:");
console.log(`  corr(growth, PE)        ${fmt(corrLevel, 3)}`);
console.log(`  corr(growth, log PE)    ${fmt(corrLog, 3)}`);
if (fit) {
  // A slope on log PE: a 10pp increase in growth multiplies PE by e^(0.1·slope).
  const perTenPoints = Math.exp(fit.slope * 0.1);
  console.log(`  slope on log PE         ${fmt(fit.slope, 3)}  ⇒ +10pp growth multiplies PE by ${fmt(perTenPoints, 3)}x`);
}
console.log("");
console.log("Same question without letting one outlier dominate — median PE per growth bucket:");
console.log(`${"growth bucket".padEnd(18)}${"n".padStart(4)}${"median PE".padStart(11)}${"median growth".padStart(15)}`);
console.log("─".repeat(48));
let lastMedian = null;
let rising = 0;
let falling = 0;
for (const bucket of buckets) {
  if (bucket.n === 0) {
    console.log(`${bucket.label.padEnd(18)}${String(0).padStart(4)}${"—".padStart(11)}${"—".padStart(15)}`);
    continue;
  }
  console.log(
    `${bucket.label.padEnd(18)}${String(bucket.n).padStart(4)}${fmt(bucket.medianPe).padStart(11)}${pct(bucket.medianGrowthPct / 100).padStart(15)}`,
  );
  if (lastMedian !== null && typeof bucket.medianPe === "number") {
    if (bucket.medianPe > lastMedian) rising += 1;
    else falling += 1;
  }
  if (typeof bucket.medianPe === "number") lastMedian = bucket.medianPe;
}
console.log("");
console.log(`Buckets where median PE rises with growth: ${rising}   falls: ${falling}`);
console.log("");

console.log("Per archetype — does PEG normalise better than PE?");
console.log(`${"archetype".padEnd(23)}${"n".padStart(3)}${"PE med".padStart(9)}${"growth med".padStart(12)}${"PEG med".padStart(10)}`);
console.log("─".repeat(60));
for (const item of archetypes) {
  console.log(
    `${item.archetype.padEnd(23)}${String(item.withGrowth).padStart(3)}${fmt(item.medianPe).padStart(9)}${pct(item.medianGrowthPct / 100).padStart(12)}${fmt(item.medianPeg).padStart(10)}`,
  );
}
console.log("");

const peValues = archetypes.map((item) => item.medianPe).filter((value) => typeof value === "number");
const pegValues = archetypes.map((item) => item.medianPeg).filter((value) => typeof value === "number");
const spread = (values) => (values.length < 2 ? null : Math.max(...values) / Math.min(...values));
console.log(`Median PE spread across archetypes:  ${fmt(spread(peValues), 1)}x`);
console.log(`Median PEG spread across archetypes: ${fmt(spread(pegValues), 1)}x`);
console.log("");
console.log("If the PEG spread is not much smaller than the PE spread, growth does not");
console.log("normalise the multiple and a growth-linked band is just a relabelled PE band.");
