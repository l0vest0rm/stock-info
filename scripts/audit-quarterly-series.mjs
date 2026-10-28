#!/usr/bin/env node
/**
 * Audit the quarterly series for every A-share in the watchlist.
 *
 * Checks, per code:
 *  1. both income families are present (`families.cumulative` / `quarterized`)
 *  2. the reported identity `Σ single quarters == cumulative` holds
 *  3. the fiscal-year point's `cumulative` equals its own `ttm`
 *  4. TTM is non-null on the newest point (PE(TTM) is computable)
 *
 * Usage:
 *   node scripts/audit-quarterly-series.mjs --base-url http://127.0.0.1:8000
 *   node scripts/audit-quarterly-series.mjs --base-url ... --codes 300308.SZ,600519.SH
 *
 * Requires a running API (see ./start-local.sh). Read-only.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const baseUrl = option("--base-url", "http://127.0.0.1:8000").replace(/\/$/, "");
const explicitCodes = option("--codes", "");
const limit = Number(option("--limit", "16"));
const concurrency = Number(option("--concurrency", "4"));
const tolerance = 1e-4; // 亿 rounding from two decimals; use absolute 万元 tolerance instead

async function universeCodes() {
  const universe = JSON.parse(await readFile(path.join(repositoryRoot, "config/investment-universe.json"), "utf8"));
  const codes = [];
  for (const company of universe.companies ?? []) {
    const preferred = company.preferredTicker;
    if (typeof preferred === "string" && /\.(SH|SZ|BJ)$/.test(preferred)) codes.push(preferred);
  }
  return [...new Set(codes)];
}

const codes = explicitCodes
  ? explicitCodes.split(",").map((code) => code.trim()).filter(Boolean)
  : await universeCodes();

const results = [];
let cursor = 0;

async function worker() {
  while (cursor < codes.length) {
    const code = codes[cursor++];
    try {
      const response = await fetch(`${baseUrl}/api/finance/income/quarterly-series?code=${encodeURIComponent(code)}&limit=${limit}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const data = body?.data;
      if (!data) throw new Error("no data field");
      results.push(check(code, data));
    } catch (error) {
      results.push({ code, status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function check(code, data) {
  const points = Array.isArray(data.points) ? data.points : [];
  const families = data.families ?? { cumulative: false, quarterized: false };
  const byDate = new Map(points.map((point) => [point.reportDate, point]));
  const failures = [];
  const notes = [];

  if (!families.cumulative) failures.push("missing_cumulative_family");
  if (!families.quarterized) notes.push("missing_quarterized_family");

  // Identity 1: sum of single quarters == cumulative, per year.  The running
  // sum must start at Q1, so a year whose Q1 falls outside the requested
  // window is skipped rather than compared from a mid-year offset.
  const years = [...new Set(points.map((point) => point.reportDate.slice(0, 4)))].sort();
  const identities = [];
  for (const year of years) {
    const q1 = byDate.get(`${year}-03-31`);
    if (!q1 || typeof q1.quarterRevenue !== "number") continue;
    let running = 0;
    for (const suffix of ["03-31", "06-30", "09-30", "12-31"]) {
      const point = byDate.get(`${year}-${suffix}`);
      if (!point || typeof point.quarterRevenue !== "number") continue;
      running += point.quarterRevenue;
      const cumulative = point.cumulativeRevenue;
      if (typeof cumulative !== "number") continue;
      // Eastmoney stores yuan as floats; allow sub-万元 drift at 10^10 scale.
      const ok = Math.abs(running - cumulative) < 5_000;
      identities.push({ period: `${year}-${suffix}`, running, cumulative, ok });
      if (!ok) failures.push(`identity_${year}-${suffix}`);
    }
  }

  // Identity 2: FY cumulative == FY ttm.
  for (const point of points.filter((item) => item.reportDate.endsWith("12-31"))) {
    if (typeof point.cumulativeRevenue !== "number" || typeof point.ttmRevenue !== "number") continue;
    if (Math.abs(point.cumulativeRevenue - point.ttmRevenue) > 5_000) failures.push(`annual_ttm_${point.reportDate}`);
  }

  const newest = points[0];
  if (newest && newest.ttmRevenue === null) notes.push("ttm_unavailable_on_latest");

  return {
    code,
    status: failures.length === 0 ? "ok" : "fail",
    families,
    latestReportDate: data.latestReportDate,
    latestTtmRevenue: newest?.ttmRevenue ?? null,
    complete: data.complete,
    failures,
    notes,
    identities: identities.filter((item) => !item.ok),
  };
}

await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

const summary = {
  baseUrl,
  checked: results.length,
  ok: results.filter((item) => item.status === "ok").length,
  fail: results.filter((item) => item.status === "fail").length,
  error: results.filter((item) => item.status === "error").length,
  missingCumulative: results.filter((item) => item.families && !item.families.cumulative).map((item) => item.code),
  missingQuarterized: results.filter((item) => item.families && item.families.cumulative && !item.families.quarterized).map((item) => item.code),
  failures: results.filter((item) => item.failures?.length).map((item) => ({ code: item.code, failures: item.failures, identities: item.identities })),
  errors: results.filter((item) => item.status === "error").map((item) => ({ code: item.code, error: item.error })),
};

console.log(JSON.stringify(summary, null, 2));
if (summary.fail > 0 || summary.error > 0) process.exitCode = 1;
