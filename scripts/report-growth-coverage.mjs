#!/usr/bin/env node
/**
 * How fresh and how complete is the growth input?
 *
 * A growth-linked band is only as good as the growth reading behind it, so the
 * first question is not "what multiple does 30% deserve" but "for how many
 * companies do we have 30% at all, and as of when".
 *
 * The repository merges three sources for the newest period, in priority order:
 *   1. a formal quarterly/interim report (`financial_report`);
 *   2. a 业绩快报 performance express (`performance_report`);
 *   3. a 业绩预告 performance forecast (`performance_forecast`).
 * Annual reports are deliberately excluded from the freshness test — a December
 * annual quoted in October is a year stale by construction.
 *
 * Reports, per company:
 *   - newest period available and how old it is;
 *   - whether that period came from a formal filing or a provisional one;
 *   - whether a year-on-year net-profit figure is actually present.
 *
 * Read-only. No band is changed, no target is emitted.
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

/** Trading days between two ISO dates, as a rough staleness measure. */
function daysBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

async function collect(target) {
  const data = await getJson(`/api/finance/income/quarterly-series?code=${encodeURIComponent(target.code)}&limit=8`);
  const points = data?.points ?? [];
  const latest = points[0] ?? null;
  if (!latest) {
    return { ...target, reportDate: null, fiscalPeriod: null, provisional: null, ageDays: null, hasYoY: false, hasTtmYoY: false };
  }
  const yearAgo = points.find((point) => {
    const time = Date.parse(`${point.reportDate}T00:00:00Z`);
    const latestTime = Date.parse(`${latest.reportDate}T00:00:00Z`);
    return Number.isFinite(time) && Math.abs(time - (latestTime - 365 * 86_400_000)) < 45 * 86_400_000;
  }) ?? null;
  return {
    ...target,
    reportDate: latest.reportDate ?? null,
    fiscalPeriod: latest.fiscalPeriod ?? null,
    provisional: latest.provisional ?? null,
    ageDays: latest.reportDate ? daysBetween(latest.reportDate, "2026-10-28") : null,
    singleQuarterYoY: typeof latest.netProfitYoY === "number" ? latest.netProfitYoY : null,
    hasYoY: typeof latest.netProfitYoY === "number",
    // TTM growth needs both this period's and the year-ago period's TTM profit.
    hasTtmYoY: typeof latest.ttmNetProfit === "number"
      && typeof yearAgo?.ttmNetProfit === "number"
      && latest.ttmNetProfit > 0 && yearAgo.ttmNetProfit > 0,
    ttmYoY: typeof latest.ttmNetProfit === "number" && typeof yearAgo?.ttmNetProfit === "number" && yearAgo.ttmNetProfit > 0
      ? latest.ttmNetProfit / yearAgo.ttmNetProfit - 1
      : null,
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
      rows.push({ ...targets[index], reportDate: null, ageDays: null, hasYoY: false, hasTtmYoY: false });
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
rows.sort((left, right) => left.code.localeCompare(right.code));

const withAny = rows.filter((row) => row.reportDate !== null);
const withYoY = rows.filter((row) => row.hasYoY);
const withTtmYoY = rows.filter((row) => row.hasTtmYoY);
const provisional = rows.filter((row) => row.provisional === true);

const byPeriod = new Map();
for (const row of withAny) {
  const key = row.fiscalPeriod ?? String(row.reportDate ?? "unknown");
  if (!byPeriod.has(key)) byPeriod.set(key, 0);
  byPeriod.set(key, byPeriod.get(key) + 1);
}
const periods = [...byPeriod.entries()].sort((left, right) => right[1] - left[1]);

const byMarket = new Map();
for (const row of rows) {
  if (!byMarket.has(row.market)) byMarket.set(row.market, { total: 0, withTtmYoY: 0, withYoY: 0 });
  const entry = byMarket.get(row.market);
  entry.total += 1;
  if (row.hasTtmYoY) entry.withTtmYoY += 1;
  if (row.hasYoY) entry.withYoY += 1;
}

if (asJson) {
  console.log(JSON.stringify({
    asOf: "2026-10-28",
    companies: rows.length,
    withNewestPeriod: withAny.length,
    withSingleQuarterYoY: withYoY.length,
    withTtmYoY: withTtmYoY.length,
    provisional,
    byPeriod: periods.map(([period, count]) => ({ period, count })),
    byMarket: [...byMarket.entries()].map(([market, entry]) => ({ market, ...entry })),
    rows,
  }, null, 2));
  process.exit(0);
}

const pct = (value) => (typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—");

console.log("Growth input freshness and coverage (as of 2026-10-28)");
console.log("");
console.log(`Companies: ${rows.length}`);
console.log(`  with a newest quarterly/interim period   ${withAny.length}`);
console.log(`  with single-quarter YoY net profit       ${withYoY.length}`);
console.log(`  with TTM YoY (needs year-ago TTM profit) ${withTtmYoY.length}`);
console.log(`  whose newest period is provisional       ${provisional.length}`);
console.log("");
console.log("Newest period in use:");
for (const [period, count] of periods) {
  console.log(`  ${String(period).padEnd(12)} ${String(count).padStart(3)}`);
}
console.log("");
console.log("By market:");
console.log(`${"market".padEnd(8)}${"n".padStart(4)}${"Q-YoY".padStart(8)}${"TTM-YoY".padStart(9)}`);
for (const [market, entry] of [...byMarket.entries()].sort()) {
  console.log(`${market.padEnd(8)}${String(entry.total).padStart(4)}${String(entry.withYoY).padStart(8)}${String(entry.withTtmYoY).padStart(9)}`);
}
console.log("");

const stale = withAny.filter((row) => typeof row.ageDays === "number" && row.ageDays > 120);
if (stale.length > 0) {
  console.log(`Newest period is over 120 days old (${stale.length}):`);
  for (const row of stale.slice(0, 25)) {
    console.log(`  ${row.code.padEnd(11)} ${row.name}  ${row.reportDate}  ${row.ageDays} 天`);
  }
  console.log("");
}

const missing = rows.filter((row) => !row.hasTtmYoY);
if (missing.length > 0) {
  console.log(`No TTM YoY growth (${missing.length}):`);
  for (const row of missing) {
    console.log(`  ${row.code.padEnd(11)} ${row.name}  ${row.reportDate ?? "no period"}`);
  }
  console.log("");
}

if (provisional.length > 0) {
  console.log(`Provisional period in use (${provisional.length}) — figures are forecasts or express reports:`);
  for (const row of provisional) {
    console.log(`  ${row.code.padEnd(11)} ${row.name}  ${row.reportDate}  ${pct(row.singleQuarterYoY)}`);
  }
}
