#!/usr/bin/env node
/**
 * Fetch a US equity option chain plus underlying K-lines and cache it, mirroring
 * the A-share pipeline in scripts/fetch-etf-option-chain.mjs.
 *
 * Data sources (repo-local first, per project policy):
 *   - Option chain  : local GET /api/options/us/contracts (Nasdaq-backed, includes bid/ask)
 *   - Underlying    : local GET /api/kline  (Xueqiu-backed)
 *
 * US chains differ from SSE ETF options in ways that matter for analysis:
 *   - expiries are weekly/biweekly/monthly (dozens of dates, not four months)
 *   - premiums carry live bid/ask, so a seller's executable price is the bid
 *   - contract multiplier is 100, not 10,000
 *   - strikes are far denser
 *
 * Usage:
 *   node scripts/fetch-us-option-chain.mjs --code NVDA.US
 *   node scripts/fetch-us-option-chain.mjs --code MU.US --expiries 3 --out data/research/us-options/MU
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  code: "NVDA.US",
  apiBase: "http://127.0.0.1:8000",
  expiries: 4, // how many upcoming expiries to pull chains for
  minDays: 14, // skip ultra-short weeklies: gamma-dominated and not representative
  out: null,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--code") options.code = next();
    else if (a === "--api-base") options.apiBase = next();
    else if (a === "--expiries") options.expiries = Number(next());
    else if (a === "--min-days") options.minDays = Number(next());
    else if (a === "--out") options.out = next();
    else if (a === "--help" || a === "-h") options.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return options;
}

async function fetchJson(url, timeoutMs = 180_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const body = await response.json();
  if (body?.code !== 200) throw new Error(`${body?.msg ?? "api error"} (${url})`);
  return body.data;
}

/**
 * Nasdaq labels expiries as "November 20, 2026". Keep the vendor label for API
 * round-trips but also store ISO so downstream code never parses English dates.
 */
function usDateToIso(label) {
  const t = Date.parse(label);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/** Extract the OCC-ish expiry code from a Nasdaq option symbol (e.g. nvda--261120c00002500). */
function parseOccSymbol(symbol) {
  const m = /^([a-z]+)--(\d{2})(\d{2})(\d{2})([cp])(\d+)$/i.exec(String(symbol ?? ""));
  if (!m) return null;
  return { root: m[1], yy: Number(m[2]), mm: Number(m[3]), dd: Number(m[4]), right: m[5].toLowerCase(), strikeRaw: Number(m[6]) };
}

function normalizeContract(c, kind) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const bid = num(c.bid);
  const ask = num(c.ask);
  const mid = bid !== null && ask !== null && bid > 0 && ask > 0 ? (bid + ask) / 2 : num(c.price);
  return {
    symbol: c.symbol,
    kind,
    expiryVendor: c.expiration ?? null,
    expiry: usDateToIso(c.expiration ?? ""),
    strike: num(c.strike),
    last: num(c.last),
    bid,
    ask,
    mid,
    volume: num(c.volume),
    openInterest: num(c.openInterest),
    // A buyer pays the ask, a seller receives the bid — same convention as the A-share pipeline.
    executableBid: bid !== null && bid > 0 ? bid : null,
    executableAsk: ask !== null && ask > 0 ? ask : null,
  };
}

async function fetchKline(apiBase, code) {
  const url = new URL("/api/kline", apiBase);
  url.searchParams.set("code", code);
  url.searchParams.set("period", "day");
  url.searchParams.set("fq", "qfq");
  url.searchParams.set("from", "1990-01-01");
  url.searchParams.set("format", "structured");
  return fetchJson(url.toString(), 120_000);
}

function slugFor(code) {
  return `data/research/us-options/${code.replace(/\.US$/i, "")}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("node scripts/fetch-us-option-chain.mjs --code NVDA.US [--expiries 4] [--out DIR]");
    return;
  }
  const code = options.code.toUpperCase().endsWith(".US") ? options.code.toUpperCase() : `${options.code.toUpperCase()}.US`;
  const outDir = path.resolve(options.out ?? slugFor(code));
  await mkdir(outDir, { recursive: true });

  const summary = await fetchJson(
    `${options.apiBase}/api/options/us/summary?code=${encodeURIComponent(code)}`
  );
  const allExpiries = (summary.expirations ?? [])
    .map((e) => ({ vendor: e.date, iso: usDateToIso(e.date) }))
    .filter((e) => e.iso)
    .sort((a, b) => a.iso.localeCompare(b.iso));

  // Keep only upcoming expiries past the minimum horizon, nearest first.
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = allExpiries
    .filter((e) => e.iso >= today)
    .map((e) => ({ ...e, calendarDays: Math.round((Date.parse(`${e.iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) }))
    .filter((e) => e.calendarDays >= options.minDays)
    .slice(0, Math.max(1, options.expiries));

  const chains = [];
  for (const e of upcoming) {
    const url = new URL("/api/options/us/contracts", options.apiBase);
    url.searchParams.set("code", code);
    url.searchParams.set("expirations", e.vendor);
    try {
      const body = await fetchJson(url.toString(), 180_000);
      const expiration = (body.expirations ?? [])[0];
      if (!expiration) continue;
      chains.push({
        expiry: e.iso,
        expiryVendor: e.vendor,
        calls: (expiration.calls ?? []).map((c) => normalizeContract(c, "call")).filter((c) => c.strike > 0),
        puts: (expiration.puts ?? []).map((c) => normalizeContract(c, "put")).filter((c) => c.strike > 0),
      });
    } catch (error) {
      console.warn(`  warn: chain failed for ${e.vendor}: ${error.message}`);
    }
  }

  const kline = await fetchKline(options.apiBase, code);
  const lastBar = kline.at(-1);

  const payload = {
    code,
    symbol: summary.symbol,
    source: { chain: "nasdaq via local /api/options/us", kline: "xueqiu via local /api/kline" },
    tradeDate: lastBar?.date ?? null,
    underlying: {
      price: summary.currentPrice,
      close: lastBar?.close ?? null,
      date: lastBar?.date ?? null,
    },
    allExpiries: allExpiries.map((e) => e.iso),
    chains,
  };

  await writeFile(path.join(outDir, "kline-qfq.json"), JSON.stringify({ code, fq: "qfq", rows: kline }, null, 1));
  await writeFile(path.join(outDir, "option-chain.json"), JSON.stringify(payload, null, 1));

  console.log(
    JSON.stringify(
      {
        outDir,
        code,
        symbol: summary.symbol,
        tradeDate: payload.tradeDate,
        price: summary.currentPrice,
        totalExpiries: allExpiries.length,
        chainsFetched: chains.map((c) => `${c.expiry}(C${c.calls.length}/P${c.puts.length})`),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(`fetch-us-option-chain failed: ${e.message}`);
  process.exitCode = 1;
});
