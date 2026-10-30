#!/usr/bin/env node
/**
 * Does the point-in-time rebuild actually differ from Xueqiu's series, and over
 * what span?
 *
 * The module claims Xueqiu's historical `peTtm` carries future earnings.  This
 * checks that claim against the rebuild on real rows, and reports where the two
 * agree — because a rebuild that silently matches the biased series everywhere
 * would mean the bias was never there, and one that differs everywhere would
 * mean the rebuild is wrong.
 *
 * Usage:
 *   node scripts/verify-point-in-time-pe.mjs
 *   node scripts/verify-point-in-time-pe.mjs --limit=5
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPointInTimePeSeries } from './lib/rust-analysis.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const inline = args.find((item) => item.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const baseUrl = option("--base-url", "http://127.0.0.1:8000").replace(/\/+$/, "");
const limit = Number(option("--limit", "6"));

const universe = JSON.parse(readFileSync(resolve(root, "config/investment-universe.json"), "utf8"));
const apiCodeFor = (s) => (s.market === "US" && !s.ticker.endsWith(".US") ? `${s.ticker}.US` : s.ticker);
const targets = universe.companies
  .filter((c) => c.classificationStatus === "verified")
  .filter((c) => c.securities.some((s) => s.market === "CN"))
  .slice(0, limit)
  .map((c) => {
    const s = c.securities.find((x) => x.ticker === c.preferredTicker) ?? c.securities[0];
    return { name: c.displayName, code: apiCodeFor(s) };
  });

async function getJson(path) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(180_000) });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.code === 200) return body.data;
    } catch {
      // retried
    }
    await new Promise((done) => setTimeout(done, 800 * (attempt + 1)));
  }
  return null;
}

/** Only formal cumulative rows; the quarterly family is not a TTM anchor. */
function formalIncomeRows(readModel) {
  const rows = readModel?.rows ?? [];
  return rows.filter((row) => {
    const payload = row.payload ?? {};
    const type = String(payload.REPORT_TYPE ?? "").trim();
    const name = String(payload.REPORT_DATE_NAME ?? "").trim();
    // Exclude the quarterized family (2026二季度 / 2026三季度 …).
    if (type.endsWith("季度") || name.endsWith("季度")) return false;
    const profit = payload.PARENT_NETPROFIT ?? payload.NETPROFIT;
    return typeof profit === "number" && Number.isFinite(profit);
  });
}

for (const target of targets) {
  const [readModel, kline] = await Promise.all([
    getJson(`/api/finance/income?code=${encodeURIComponent(target.code)}&limit=40&format=read-model`),
    getJson(`/api/kline?code=${encodeURIComponent(target.code)}&period=day&format=structured&from=2014-01-01`),
  ]);
  const rows = formalIncomeRows(readModel);
  const bars = (Array.isArray(kline) ? kline : []).filter(
    (b) => typeof b.marketCapital === "number" && b.marketCapital > 0 && typeof b.peTtm === "number" && b.peTtm > 0,
  );
  if (rows.length === 0 || bars.length === 0) {
    console.log(`${target.code} ${target.name}  no data (rows ${rows.length}, bars ${bars.length})`);
    continue;
  }
  const series = buildPointInTimePeSeries(
    rows,
    bars.map((b) => ({ date: b.date, marketCap: b.marketCapital })),
  );
  const byDate = new Map(bars.map((b) => [b.date, b.peTtm]));
  const usable = series.filter((p) => p.peTtm !== null);
  if (usable.length === 0) {
    console.log(`${target.code} ${target.name}  no usable PIT point (rows ${rows.length} from ${rows.at(-1)?.reportDate})`);
    continue;
  }
  let differs = 0;
  let worst = 0;
  let worstDate = null;
  for (const point of usable) {
    const xueqiu = byDate.get(point.date);
    if (typeof xueqiu !== "number") continue;
    const error = point.peTtm / xueqiu - 1;
    if (Math.abs(error) > 0.02) {
      differs += 1;
      if (Math.abs(error) > Math.abs(worst)) {
        worst = error;
        worstDate = point.date;
      }
    }
  }
  console.log(
    `${target.code.padEnd(11)}${String(target.name).padEnd(10)}`
    + ` PIT ${usable[0].date}..${usable.at(-1).date}`
    + `  days ${String(usable.length).padStart(4)}`
    + `  differs ${String(differs).padStart(4)} (${((differs / usable.length) * 100).toFixed(1)}%)`
    + `  worst ${(worst * 100).toFixed(1)}% ${worstDate ?? ""}`,
  );
}
