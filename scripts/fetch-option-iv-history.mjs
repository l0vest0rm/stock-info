#!/usr/bin/env node
/**
 * Fetch per-contract daily K-lines for a cached ETF option chain and reconstruct
 * the implied-volatility surface history.
 *
 * This answers "is today's IV rich or cheap?" without needing a vendor vol feed:
 * for every contract we know the strike, the expiry, and the underlying's daily
 * close, so T and S are available for each historical bar.
 *
 * Requires data/research/<slug>/option-chain.json and kline-*.json from
 * scripts/fetch-etf-option-chain.mjs.
 *
 * Usage:
 *   node scripts/fetch-option-iv-history.mjs --dir data/research/covered-call-588000
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { impliedVol } from "./lib/option-pricing.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
const TRADING_DAYS = 243;
const RISK_FREE_RATE = 0.015;

function parseArgs(argv) {
  const options = { dir: "data/research/covered-call-588000", concurrency: 6, refresh: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--dir") options.dir = next();
    else if (arg === "--concurrency") options.concurrency = Number(next());
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/**
 * Eastmoney requires the public `ut` token on its quote APIs. Without it the
 * historical K-line host answers `rc:102` with `data:null` (or an empty response),
 * which is easy to misread as an IP block. This value is the constant used by
 * quote.eastmoney.com itself, not a user credential.
 */
const EASTMONEY_UT = "fa5fd1943c7b386f172d6893dbfba10b";

function eastmoneySecidForOption(code) {
  return `10.${code}`;
}

async function fetchOptionKline(code) {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?ut=${EASTMONEY_UT}&secid=${eastmoneySecidForOption(code)}` +
    `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=0&end=20500101&lmt=400`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      // rc != 0 means Eastmoney refused the call (102 = missing/invalid ut, 0 = ok).
      // Surface it instead of silently returning an empty series.
      if (body?.rc !== 0) throw new Error(`eastmoney rc=${body?.rc}`);
      const lines = body?.data?.klines ?? [];
      return lines.map((line) => {
        const [date, open, close, high, low, volume, amount, amplitude] = line.split(",");
        return {
          date,
          open: Number(open),
          close: Number(close),
          high: Number(high),
          low: Number(low),
          volume: Number(volume),
          amount: Number(amount),
          amplitude: Number(amplitude),
        };
      });
    } catch (error) {
      if (attempt === 2) return { error: String(error?.message ?? error) };
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  return { error: "unreachable" };
}

function tradingDaysUntil(fromDate, expiry) {
  const start = Date.parse(`${fromDate}T00:00:00Z`);
  const end = Date.parse(`${expiry}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  // Approximate trading days: calendar days * 243/365, floored at 0.
  const calendarDays = Math.round((end - start) / 86_400_000);
  if (calendarDays <= 0) return 0;
  return Math.round((calendarDays * TRADING_DAYS) / 365);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("node scripts/fetch-option-iv-history.mjs [--dir data/research/covered-call-588000] [--refresh]");
    return;
  }
  const dir = path.resolve(options.dir);
  const chain = JSON.parse(await readFile(path.join(dir, "option-chain.json"), "utf8"));
  const underlyingRows = JSON.parse(await readFile(path.join(dir, "kline-qfq.json"), "utf8")).rows;
  const closeByDate = new Map(underlyingRows.map((r) => [r.date, r.close]));

  let cachePath = path.join(dir, "option-kline-history.json");
  let cache = {};
  if (!options.refresh) {
    try {
      cache = JSON.parse(await readFile(cachePath, "utf8"));
    } catch {
      cache = {};
    }
  }

  const contracts = [...chain.calls, ...chain.puts].filter((c) => c.expiry);
  // A cached contract still needs a refetch when its newest bar is behind the
  // underlying's newest bar: otherwise the IV surface silently freezes at the
  // first crawl date. `--refresh` forces a full re-pull.
  const latestUnderlyingDate = underlyingRows.at(-1)?.date ?? null;
  const isStale = (contract) => {
    const bars = cache[contract.code];
    if (!Array.isArray(bars) || bars.length === 0) return true;
    if (!latestUnderlyingDate) return false;
    return (bars.at(-1)?.date ?? "") < latestUnderlyingDate;
  };
  const pending = options.refresh ? contracts : contracts.filter(isStale);
  console.log(
    `contracts=${contracts.length} fresh=${contracts.length - pending.length} toFetch=${pending.length}`
    + (latestUnderlyingDate ? ` (underlying latest bar=${latestUnderlyingDate})` : "")
  );

  let cursor = 0;
  let done = 0;
  const failed = [];
  const worker = async () => {
    while (cursor < pending.length) {
      const contract = pending[cursor++];
      const result = await fetchOptionKline(contract.code);
      if (Array.isArray(result) && result.length > 0) {
        cache[contract.code] = result;
      } else {
        // Do not cache an empty result: it would look "stale" on every later run and
        // trigger a re-fetch forever. Keep the previous good bars if we have them.
        failed.push(contract.code);
        if (!Array.isArray(cache[contract.code]) || cache[contract.code].length === 0) {
          delete cache[contract.code];
        }
      }
      done += 1;
      if (done % 20 === 0) console.log(`  fetched ${done}/${pending.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  if (failed.length > 0) {
    console.warn(`  warn: ${failed.length} contract(s) returned no K-line and were left uncached: ${failed.slice(0, 8).join(",")}${failed.length > 8 ? "…" : ""}`);
  }

  // Drop contracts that are no longer listed (expired), so the cache does not grow forever.
  const liveCodes = new Set(contracts.map((c) => c.code));
  let pruned = 0;
  for (const code of Object.keys(cache)) {
    if (!liveCodes.has(code)) {
      delete cache[code];
      pruned += 1;
    }
  }
  if (pruned > 0) console.log(`  pruned ${pruned} expired contract(s) from cache`);

  await writeFile(cachePath, JSON.stringify(cache));

  // Reconstruct IV per contract per day.
  const ivByDateExpiry = new Map(); // date -> Map(expiry -> [{strike, iv, code, kind, close}])
  for (const contract of contracts) {
    const bars = cache[contract.code] ?? [];
    for (const bar of bars) {
      const spot = closeByDate.get(bar.date);
      if (!spot || !(bar.close > 0)) continue;
      const td = tradingDaysUntil(bar.date, contract.expiry);
      if (td <= 0) continue;
      const T = td / TRADING_DAYS;
      const iv = impliedVol(bar.close, spot, contract.strike, T, RISK_FREE_RATE, contract.kind);
      if (iv === null || !Number.isFinite(iv) || iv <= 0 || iv > 3) continue;
      if (!ivByDateExpiry.has(bar.date)) ivByDateExpiry.set(bar.date, new Map());
      const byExpiry = ivByDateExpiry.get(bar.date);
      if (!byExpiry.has(contract.expiry)) byExpiry.set(contract.expiry, []);
      byExpiry.get(contract.expiry).push({ strike: contract.strike, ivPct: iv * 100, code: contract.code, kind: contract.kind, price: bar.close });
    }
  }

  // ATM IV per date/expiry: linear interpolation in strike around spot.
  const atm = [];
  for (const [date, byExpiry] of [...ivByDateExpiry].sort((a, b) => a[0].localeCompare(b[0]))) {
    const spot = closeByDate.get(date);
    for (const [expiry, points] of byExpiry) {
      const atmIv = interpolateAtm(points, spot);
      if (atmIv === null) continue;
      atm.push({
        date,
        expiry,
        days: tradingDaysUntil(date, expiry),
        atmIvPct: atmIv,
        skew25d: skew(points, spot),
        points: points.length,
      });
    }
  }

  await writeFile(path.join(dir, "iv-history.json"), JSON.stringify({ generatedAt: new Date().toISOString(), atm }, null, 1));
  console.log(`iv-history.json written: ${atm.length} date/expiry observations`);
}

function interpolateAtm(points, spot) {
  const sorted = [...points].sort((a, b) => a.strike - b.strike);
  let lower = null;
  let upper = null;
  for (const p of sorted) {
    if (p.strike <= spot) lower = p;
    if (p.strike >= spot && !upper) upper = p;
  }
  if (lower && upper && lower.strike !== upper.strike) {
    const w = (spot - lower.strike) / (upper.strike - lower.strike);
    return lower.ivPct * (1 - w) + upper.ivPct * w;
  }
  if (lower) return lower.ivPct;
  if (upper) return upper.ivPct;
  return null;
}

/** IV at roughly +10% OTM call minus ATM IV, a compact call-skew measure. */
function skew(points, spot) {
  const target = spot * 1.1;
  const sorted = [...points].sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target));
  if (sorted.length === 0) return null;
  return sorted[0].ivPct - interpolateAtm(points, spot);
}

main().catch((error) => {
  console.error(`iv history failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
