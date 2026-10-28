#!/usr/bin/env node
/**
 * Is growth a usable anchor for a PE band?
 *
 * The proposal is: pick the multiple from the growth rate, because a 30% grower
 * deserves a different PE than a 5% grower.  That is a claim about a
 * *relationship*, and a relationship can be measured before it is used.
 *
 * A band has to predict, so three things must hold for growth to be a sound
 * anchor.  Each is tested here:
 *
 *   1. **Persistence** — if this year's growth says nothing about next year's,
 *      then "growing 30% now" is not a reason to pay a higher multiple, because
 *      the 30% is already over by the time the band is applied.
 *   2. **Contemporaneous link** — do companies trading at high multiples
 *      actually grow faster?  If not, a growth-linked band contradicts the
 *      market rather than describing it.
 *   3. **Forward link** — does a high multiple today precede faster growth?  A
 *      band built on growth is implicitly betting that it does.
 *
 * Annual reports are used here deliberately, and this is not the "stale growth"
 * mistake: the question is about *history* — how growth behaves over time — so
 * each observation has to be the growth as it was known at that fiscal year end.
 * The current-period growth reading elsewhere in this repo comes from quarterly
 * and provisional reports, which is the right source for *today*.
 *
 * Read-only. Never writes a band, never emits a target or an instruction.
 *
 * Usage:
 *   node scripts/analyze-growth-persistence.mjs
 *   node scripts/analyze-growth-persistence.mjs --json
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
const concurrency = Math.max(1, Number(option("--concurrency", "4")) || 4);
const minPairs = Math.max(3, Number(option("--min-pairs", "4")) || 4);

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

/**
 * Fiscal-year net profit, one entry per annual period.
 *
 * The three markets label annual rows differently — A-shares use REPORT_TYPE
 * `年报`, Hong Kong uses REPORT_DATE_NAME ending in `年报`, and US filings carry
 * `FISCAL_PERIOD = 12M` — so each is matched on its own declaration rather than
 * on a December date.
 */
function annualNetProfits(rows) {
  if (!Array.isArray(rows)) return [];
  const annual = [];
  for (const row of rows) {
    const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
    const reportType = String(row?.REPORT_TYPE ?? payload.REPORT_TYPE ?? "");
    const reportName = String(row?.REPORT_DATE_NAME ?? payload.REPORT_DATE_NAME ?? "");
    const fiscalPeriod = String(payload.FISCAL_PERIOD ?? row?.FISCAL_PERIOD ?? "");
    const isAnnual = reportType === "年报" || reportName.endsWith("年报") || fiscalPeriod === "12M";
    if (!isAnnual) continue;
    const profit = row?.PARENT_NETPROFIT ?? payload.PARENT_NETPROFIT;
    const date = String(row?.REPORT_DATE ?? payload.REPORT_DATE ?? "").slice(0, 10);
    if (typeof profit !== "number" || !Number.isFinite(profit) || !date) continue;
    annual.push({ date, profit });
  }
  // One row per fiscal year; keep the first occurrence per date.
  const byDate = new Map();
  for (const item of annual) if (!byDate.has(item.date)) byDate.set(item.date, item);
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

/** Daily PE series from Xueqiu, keyed for nearest-date lookup. */
function peSeries(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => typeof row.peTtm === "number" && row.peTtm > 0)
    .map((row) => ({ date: row.date, pe: row.peTtm, close: typeof row.close === "number" ? row.close : null }))
    .filter((row) => typeof row.date === "string")
    .sort((left, right) => left.date.localeCompare(right.date));
}

/** Point on the trading day closest to `date`, within `windowDays`. */
function nearestPoint(series, date, windowDays = 10) {
  if (series.length === 0) return null;
  const target = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(target)) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const point of series) {
    const time = Date.parse(`${point.date}T00:00:00Z`);
    if (!Number.isFinite(time)) continue;
    const distance = Math.abs(time - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  if (!best || bestDistance > windowDays * 86_400_000) return null;
  return best;
}

async function collect(target) {
  const [income, kline] = await Promise.all([
    getJson(`/api/finance/income?code=${encodeURIComponent(target.code)}&limit=80`),
    getJson(`/api/kline?code=${encodeURIComponent(target.code)}&period=day&format=structured&from=2014-01-01`),
  ]);
  const annual = annualNetProfits(income);
  const pe = peSeries(kline);

  // growth_t needs profit_{t-1}; PE_t is measured at fiscal year end t.
  //
  // PE is stored directly, but the *inverse* earnings yield (E/P) is what makes
  // the test honest: PE_t and growth_{t+1} both contain E_t, so a correlation
  // between log PE_t and E_{t+1}/E_t is partly guaranteed by construction
  // (a small E_t inflates both).  `earningsYield = 1/PE` still contains E_t, but
  // the price drift over the year is removed, which is what makes the pair
  // interpretable rather than mechanical.
  const observations = [];
  for (let index = 1; index < annual.length; index += 1) {
    const previous = annual[index - 1];
    const current = annual[index];
    if (previous.profit <= 0 || current.profit <= 0) continue;
    const growth = current.profit / previous.profit - 1;
    if (!Number.isFinite(growth) || Math.abs(growth) > 20) continue;
    const point = nearestPoint(pe, current.date);
    if (!point) continue;
    observations.push({
      date: current.date,
      growth,
      pe: point.pe,
      earningsYield: 1 / point.pe,
      close: point.close,
    });
  }
  return { ...target, annual: annual.length, observations };
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
      rows.push({ ...targets[index], annual: 0, observations: [] });
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
rows.sort((left, right) => left.code.localeCompare(right.code));

// ---------------------------------------------------------------- statistics
function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function correlation(pairs) {
  const n = pairs.length;
  if (n < 3) return null;
  const xs = pairs.map((pair) => pair[0]);
  const ys = pairs.map((pair) => pair[1]);
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

// 1. Persistence: growth_t against growth_{t+1}, pooled and within company.
const persistencePooled = [];
const persistenceWithin = [];
const contemporaneousWithin = [];
const forwardWithin = [];
const forwardPartialWithin = [];

/**
 * Partial correlation of X and Y controlling for Z.
 *
 * Needed for the forward test: PE_t = P_t/E_t and growth_{t+1} = E_{t+1}/E_t
 * share E_t, so a raw correlation is partly built in — a depressed E_t inflates
 * PE_t *and* flatters next year's growth off a low base.  That is earnings mean
 * reversion, not a valuation signal.  Removing growth_t asks the narrower and
 * decision-relevant question: does today's multiple say anything about next
 * year's growth *beyond* what the current growth already says?
 */
function partialCorrelation(pairs, controls) {
  const rxy = correlation(pairs);
  const rxz = correlation(pairs.map((pair, i) => [pair[0], controls[i]]));
  const ryz = correlation(pairs.map((pair, i) => [pair[1], controls[i]]));
  if (rxy === null || rxz === null || ryz === null) return null;
  const denominator = Math.sqrt((1 - rxz * rxz) * (1 - ryz * ryz));
  if (!Number.isFinite(denominator) || denominator === 0) return null;
  return (rxy - rxz * ryz) / denominator;
}

for (const row of rows) {
  const obs = row.observations;
  for (let i = 0; i + 1 < obs.length; i += 1) {
    persistencePooled.push([obs[i].growth, obs[i + 1].growth]);
  }
  if (obs.length < minPairs) continue;
  persistenceWithin.push(correlation(obs.slice(0, -1).map((item, i) => [item.growth, obs[i + 1].growth])));
  contemporaneousWithin.push(correlation(obs.map((item) => [item.growth, Math.log(item.pe)])));

  // Does today's PE precede next year's growth?  PE_t vs growth_{t+1}.
  const forwardPairs = obs.slice(0, -1).map((item, i) => [Math.log(item.pe), obs[i + 1].growth]);
  forwardWithin.push(correlation(forwardPairs));
  // …and does it survive removing what growth_t already explains?
  forwardPartialWithin.push(
    partialCorrelation(forwardPairs, obs.slice(0, -1).map((item) => item.growth)),
  );
}

const pooledPersistence = correlation(persistencePooled);
const medianPersistence = median(persistenceWithin.filter((value) => typeof value === "number"));
const medianContemporaneous = median(contemporaneousWithin.filter((value) => typeof value === "number"));
const medianForward = median(forwardWithin.filter((value) => typeof value === "number"));
const medianForwardPartial = median(forwardPartialWithin.filter((value) => typeof value === "number"));

const companiesWithPairs = rows.filter((row) => row.observations.length >= minPairs).length;
const totalPairs = rows.reduce((sum, row) => sum + row.observations.length, 0);

if (asJson) {
  console.log(JSON.stringify({
    asOf: new Date().toISOString().slice(0, 10),
    companies: rows.length,
    companiesWithEnoughPairs: companiesWithPairs,
    totalObservations: totalPairs,
    persistence: {
      pooled: pooledPersistence,
      medianWithinCompany: medianPersistence,
    },
    contemporaneousWithinCompany: medianContemporaneous,
    forwardWithinCompany: medianForward,
    forwardPartialWithinCompany: medianForwardPartial,
    rows,
  }, null, 2));
  process.exit(0);
}

const fmt = (value, digits = 3) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—");

console.log("Is growth a usable anchor for a PE band?");
console.log("");
console.log(`Companies: ${rows.length}   observations (fiscal year + PE): ${totalPairs}`);
console.log(`Companies with ≥${minPairs} observations: ${companiesWithPairs}`);
console.log("");
console.log("1. Persistence — does this year's growth predict next year's?");
console.log(`   pooled correlation            ${fmt(pooledPersistence)}`);
console.log(`   median within company         ${fmt(medianPersistence)}`);
console.log("");
console.log("2. Contemporaneous — do high-multiple companies grow faster?");
console.log(`   median within company corr(growth_t, log PE_t)   ${fmt(medianContemporaneous)}`);
console.log("");
console.log("3. Forward — does a high multiple precede faster growth?");
console.log(`   median within company corr(log PE_t, growth_t+1)          ${fmt(medianForward)}`);
console.log(`   …controlling for growth_t (partial correlation)          ${fmt(medianForwardPartial)}`);
console.log("");
console.log("The raw forward correlation is mechanically inflated: PE_t = P_t/E_t and");
console.log("growth_t+1 = E_t+1/E_t share E_t, so a depressed E_t raises one and flatters");
console.log("the other. That is earnings mean reversion, not a valuation signal. The");
console.log("partial correlation is the one to act on.");
console.log("");
console.log("A growth-linked band needs at least one of these to be clearly positive.");
console.log("If all three are near zero, the growth rate does not carry the multiple, and");
console.log("setting the band from growth would import noise into every verdict.");
