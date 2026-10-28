#!/usr/bin/env node
/**
 * Which growth-to-multiple model actually fits?
 *
 * Saying "PE should follow growth" does not specify a function.  The candidate
 * forms differ a lot, and the choice is not a matter of taste — each can be
 * scored on the same observations:
 *
 *   A. constant multiple            PE = c                  (the current default)
 *   B. linear in growth             PE = a + b·g
 *   C. log-linear in growth         log PE = a + b·g
 *   D. Gordon growth                PE = 1 / (r − g)        (r fixed)
 *   E. PEG-normalised               PE = k·g               (equivalently PEG = k)
 *
 * Each is fitted by least squares on log PE (multiples are ratios, so the
 * residual is multiplicative) and scored by R² on the same rows, so the
 * comparison is like-for-like.  A model that cannot beat the constant is not
 * evidence for anything and must not become a band.
 *
 * Two fits are reported per model: the pooled cross-section, and the
 * within-archetype fit.  A model can look good pooled purely because
 * archetypes differ in level; the within-archetype fit is the one that would
 * justify replacing an archetype's band with a growth formula.
 *
 * Read-only. Never writes a band, never emits a target or an instruction.
 *
 * Usage:
 *   node scripts/compare-growth-models.mjs
 *   node scripts/compare-growth-models.mjs --json
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
const discountRate = Number(option("--discount-rate", "0.09")) || 0.09;

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

/** Current TTM growth, from the newest quarterly/interim period. */
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
  return now / then - 1;
}

async function collect(target) {
  const [quarterly, kline] = await Promise.all([
    getJson(`/api/finance/income/quarterly-series?code=${encodeURIComponent(target.code)}&limit=8`),
    getJson(`/api/kline?code=${encodeURIComponent(target.code)}&period=day&format=structured&from=2026-09-01`),
  ]);
  const rows = Array.isArray(kline) ? kline : [];
  const last = rows[rows.length - 1] ?? null;
  const pe = typeof last?.peTtm === "number" && last.peTtm > 0 ? last.peTtm : null;
  return {
    ...target,
    growth: ttmGrowth(quarterly?.points ?? []),
    pe,
  };
}

let cursor = 0;
const all = [];
async function worker() {
  for (;;) {
    const index = cursor++;
    if (index >= targets.length) return;
    try {
      all.push(await collect(targets[index]));
    } catch {
      all.push({ ...targets[index], growth: null, pe: null });
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

/**
 * Usable sample.
 *
 * Growth is capped at 100%: above that the base is depressed and the rate says
 * more about last year's writedown than about this year's business.  Negative
 * growth is kept — a contracting company is exactly the case where a growth
 * model should say something, and dropping it would bias the fit upward.
 */
const sample = all
  .filter((row) => typeof row.growth === "number" && typeof row.pe === "number")
  .filter((row) => row.growth <= 1 && row.growth >= -0.9)
  .map((row) => ({ ...row, logPe: Math.log(row.pe) }));

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
/** Ordinary least squares for y = a + b·x. */
function ols(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}
/** R² of predictions against observations. */
function rSquared(actual, predicted) {
  const m = mean(actual);
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < actual.length; i += 1) {
    ssRes += (actual[i] - predicted[i]) ** 2;
    ssTot += (actual[i] - m) ** 2;
  }
  if (ssTot === 0) return null;
  return 1 - ssRes / ssTot;
}

/** Predicted log PE for each candidate model, fitted on `rows`. */
function fitModels(rows) {
  const g = rows.map((row) => row.growth);
  const y = rows.map((row) => row.logPe);
  const models = {};

  // A. Constant: best constant in log space is the mean of log PE.
  models.constant = {
    label: "A. 常数倍数 (现状)",
    predicted: y.map(() => mean(y)),
    params: { c: Math.exp(mean(y)) },
  };

  // B/C. Linear and log-linear in growth — identical in log space, listed once.
  const linear = ols(g, y);
  if (linear) {
    models.linearGrowth = {
      label: "B. log PE 线性于增速",
      predicted: g.map((value) => linear.intercept + linear.slope * value),
      params: { slope: linear.slope, intercept: linear.intercept },
    };
  }

  // D. Gordon: PE = 1/(r − g), so log PE = −log(r − g).
  const gordon = rows.map((row) => -Math.log(Math.max(discountRate - row.growth, 0.005)));
  const gordonFit = ols(gordon, y);
  if (gordonFit) {
    models.gordon = {
      label: `D. Gordon PE = 1/(r−g), r=${(discountRate * 100).toFixed(0)}%`,
      predicted: gordon.map((value) => gordonFit.intercept + gordonFit.slope * value),
      params: { slope: gordonFit.slope, intercept: gordonFit.intercept },
    };
  }

  // E. PEG: PE = k·g ⇒ log PE = log k + log g.  Needs g > 0.
  const positive = rows.filter((row) => row.growth > 0);
  if (positive.length >= 3) {
    const logG = positive.map((row) => Math.log(row.growth));
    const logY = positive.map((row) => row.logPe);
    const pegFit = ols(logG, logY);
    if (pegFit) {
      models.peg = {
        label: "E. PEG 归一 (PE = k·g)",
        predicted: logG.map((value) => pegFit.intercept + pegFit.slope * value),
        actual: logY,
        params: { k: Math.exp(pegFit.intercept), exponent: pegFit.slope },
      };
    }
  }

  return models;
}

const pooledModels = fitModels(sample);
const pooledScores = Object.entries(pooledModels).map(([key, model]) => {
  const actual = model.actual ?? sample.map((row) => row.logPe);
  return {
    key,
    label: model.label,
    r2: rSquared(actual, model.predicted),
    n: actual.length,
    params: model.params,
  };
}).sort((left, right) => (right.r2 ?? -1) - (left.r2 ?? -1));

// Within-archetype: fit each archetype separately, then average R² weighted by n.
const archetypeNames = [...new Set(sample.map((row) => row.archetype))].sort();
const withinArchetype = [];
for (const archetype of archetypeNames) {
  const rows = sample.filter((row) => row.archetype === archetype);
  if (rows.length < 5) {
    withinArchetype.push({ archetype, n: rows.length, skipped: "too few companies" });
    continue;
  }
  const models = fitModels(rows);
  const scores = {};
  for (const [key, model] of Object.entries(models)) {
    const actual = model.actual ?? rows.map((row) => row.logPe);
    scores[key] = rSquared(actual, model.predicted);
  }
  withinArchetype.push({ archetype, n: rows.length, r2: scores });
}

const pooledR2 = Object.fromEntries(pooledScores.map((item) => [item.key, item.r2]));
const weighted = {};
for (const item of withinArchetype) {
  if (!item.r2) continue;
  for (const [key, value] of Object.entries(item.r2)) {
    if (typeof value !== "number") continue;
    if (!weighted[key]) weighted[key] = { sum: 0, weight: 0 };
    weighted[key].sum += value * item.n;
    weighted[key].weight += item.n;
  }
}
const withinAverages = Object.fromEntries(
  Object.entries(weighted).map(([key, entry]) => [key, entry.weight > 0 ? entry.sum / entry.weight : null]),
);

if (asJson) {
  console.log(JSON.stringify({
    asOf: new Date().toISOString().slice(0, 10),
    discountRate,
    companies: all.length,
    sample: sample.length,
    pooled: pooledScores,
    withinArchetype,
    withinAverages,
    rows: sample,
  }, null, 2));
  process.exit(0);
}

const fmt = (value, digits = 3) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—");
const show = (value) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "not fitted");

console.log("Which growth-to-multiple model fits?");
console.log("");
console.log(`Companies: ${all.length}   usable sample: ${sample.length}  (growth capped at +100%)`);
console.log("");
console.log("Pooled cross-section — R² of log PE:");
console.log(`${"model".padEnd(38)}${"R²".padStart(8)}`);
console.log("─".repeat(48));
for (const item of pooledScores) {
  console.log(`${item.label.padEnd(38)}${show(item.r2).padStart(8)}`);
}
console.log("");
const baseline = pooledR2.constant;
if (typeof baseline === "number") {
  console.log(`A model must beat the constant's R² = ${fmt(baseline)} to be evidence for anything.`);
  for (const item of pooledScores) {
    if (item.key === "constant" || typeof item.r2 !== "number") continue;
    const delta = item.r2 - baseline;
    console.log(`  ${item.label.padEnd(36)} ΔR² = ${delta >= 0 ? "+" : ""}${fmt(delta)}`);
  }
}
console.log("");
console.log("Within archetype — weighted mean R² (the test that would justify replacing a band):");
for (const [key, value] of Object.entries(withinAverages)) {
  console.log(`  ${key.padEnd(16)} ${show(value)}`);
}
console.log("");
console.log("Archetypes fitted:");
for (const item of withinArchetype) {
  if (item.skipped) {
    console.log(`  ${item.archetype.padEnd(23)} n=${item.n}  skipped (${item.skipped})`);
    continue;
  }
  const parts = Object.entries(item.r2).map(([key, value]) => `${key}=${fmt(value, 2)}`);
  console.log(`  ${item.archetype.padEnd(23)} n=${String(item.n).padStart(2)}  ${parts.join("  ")}`);
}
