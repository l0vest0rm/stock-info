#!/usr/bin/env node
/**
 * Fetch a China exchange-traded ETF option chain plus underlying K-lines and cache
 * it as JSON under data/research/<slug>/ so analysis can be rerun offline.
 *
 * Data sources
 *   - Underlying K-line: local runtime API  GET /api/kline (Xueqiu-backed)
 *   - Option chain:      Eastmoney push2 quote list (secid 1.<underlying>) spt=8 (calls) + spt=10 (puts)
 *   - Per-contract info: Sina option quote  hq.sinajs.cn CON_OP_<code> (expiry, IV, greeks, OI)
 *
 * Usage:
 *   node scripts/fetch-etf-option-chain.mjs --code 588000.SH --out data/research/covered-call-588000
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  code: "588000.SH",
  out: "data/research/covered-call-588000",
  apiBase: "http://127.0.0.1:8000",
};

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Eastmoney requires the public `ut` token on its quote APIs. Without it the
 * historical K-line host answers `rc:102` with `data:null` (or an empty response),
 * which is easy to misread as an IP block. This is the constant quote.eastmoney.com
 * itself uses, not a user credential.
 */
const EASTMONEY_UT = "fa5fd1943c7b386f172d6893dbfba10b";

function parseArgs(argv) {
  const options = { ...DEFAULTS, tradeDate: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--code") options.code = next();
    else if (arg === "--out") options.out = next();
    else if (arg === "--api-base") options.apiBase = next();
    else if (arg === "--trade-date") options.tradeDate = next();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function eastmoneySecid(code) {
  const [symbol, market] = code.split(".");
  if (market === "SH") return `1.${symbol}`;
  if (market === "SZ") return `0.${symbol}`;
  throw new Error(`unsupported underlying market for eastmoney secid: ${code}`);
}

const CHAIN_FIELDS = [
  "f12", // option code
  "f14", // name
  "f2", // last price
  "f3", // pct change
  "f108", // volume (lots)
  "f161", // strike
  "f162", // days to expiry (vendor field)
  "f163", // ? (vendor delta-ish, unreliable)
  "f210", // open interest (lots)
  "f249", // vendor IV
  "f250", // vendor something
].join(",");

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const body = await response.json();
  if (body?.rc !== undefined && body.rc !== 0) throw new Error(`eastmoney rc=${body.rc} for ${url}`);
  return body;
}

async function fetchChainSide(secid, spt) {
  const url =
    `https://push2.eastmoney.com/api/qt/slist/get?spt=${spt}&fltt=2&invt=2&ut=${EASTMONEY_UT}&secid=${secid}` +
    `&fields=${CHAIN_FIELDS}&pn=1&pz=500`;
  const body = await fetchJson(url, { Referer: "https://quote.eastmoney.com/" });
  const rows = Object.values(body?.data?.diff ?? {});
  return rows.map((row) => ({
    code: String(row.f12),
    name: row.f14,
    lastPrice: typeof row.f2 === "number" ? row.f2 : null,
    pctChange: typeof row.f3 === "number" ? row.f3 : null,
    volumeLots: typeof row.f108 === "number" ? row.f108 : null,
    strike: typeof row.f161 === "number" ? row.f161 : null,
    daysToExpiryVendor: typeof row.f162 === "number" ? row.f162 : null,
    openInterestLots: typeof row.f210 === "number" ? row.f210 : null,
    vendorIvPct: typeof row.f249 === "number" ? row.f249 : null,
  }));
}

/** A-share underlying price snapshot (gives the trade date the chain belongs to). */
async function fetchUnderlyingQuote(secid) {
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fltt=2&invt=2&fields=f43,f57,f58,f60,f86`;
  const body = await fetchJson(url, { Referer: "https://quote.eastmoney.com/" });
  const data = body?.data ?? {};
  return { name: data.f58 ?? null, price: typeof data.f43 === "number" ? data.f43 : null };
}

/**
 * Sina option payload has ~51 comma fields whose numbering is not stably documented.
 * Only the two unambiguous values are trusted here: the expiry date (a bare YYYY-MM-DD
 * field, distinct from the quoted timestamp) and the quote timestamp. Prices, IV and
 * greeks are taken from Eastmoney or computed with Black-Scholes locally.
 */
function parseSinaOptionLine(line) {
  const parts = line.split(",");
  const expiry = parts.find((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)) ?? null;
  const quoteTime = parts.find((v) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) ?? null;
  return { expiry, quoteTime };
}

async function fetchSinaOptions(codes) {
  const out = new Map();
  const batchSize = 25;
  for (let i = 0; i < codes.length; i += batchSize) {
    const batch = codes.slice(i, i + batchSize);
    const url = `https://hq.sinajs.cn/list=${batch.map((c) => `CON_OP_${c}`).join(",")}`;
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://finance.sina.com.cn" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`sina HTTP ${response.status}`);
    const raw = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder("gbk").decode(raw);
    for (const line of text.split("\n")) {
      const match = /hq_str_CON_OP_(\d+)="([^"]*)"/.exec(line);
      if (!match) continue;
      if (!match[2]) continue;
      out.set(match[1], parseSinaOptionLine(match[2]));
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return out;
}

async function fetchKline(apiBase, code, fq) {
  const url = new URL("/api/kline", apiBase);
  url.searchParams.set("code", code);
  url.searchParams.set("period", "day");
  url.searchParams.set("fq", fq);
  url.searchParams.set("from", "1990-01-01");
  url.searchParams.set("format", "structured");
  const body = await fetchJson(url.toString(), { Accept: "application/json" });
  if (body?.code !== 200 || !Array.isArray(body.data)) throw new Error(`invalid kline response: ${url}`);
  return body.data;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("node scripts/fetch-etf-option-chain.mjs [--code 588000.SH] [--out data/research/covered-call-588000]");
    return;
  }
  const outDir = path.resolve(options.out);
  await mkdir(outDir, { recursive: true });
  const secid = eastmoneySecid(options.code);

  const [qfq, raw] = await Promise.all([fetchKline(options.apiBase, options.code, "qfq"), fetchKline(options.apiBase, options.code, "normal")]);
  // spt=8 returns the whole nearby board (calls AND puts); split by the name marker.
  const board = new Map();
  for (const row of await fetchChainSide(secid, 8)) {
    board.set(row.code, row);
  }
  const isCall = (name) => name.includes("购");
  const isPut = (name) => name.includes("沽");
  const rawCalls = [...board.values()].filter((r) => isCall(r.name) && !isPut(r.name));
  const rawPuts = [...board.values()].filter((r) => isPut(r.name) && !isCall(r.name));

  const allCodes = [...rawCalls, ...rawPuts].map((c) => c.code);
  const sina = await fetchSinaOptions(allCodes);

  const merge = (row, kind) => {
    const extra = sina.get(row.code) ?? {};
    const expiry = extra.expiry ?? null;
    return { ...row, kind, ...extra, expiry };
  };
  const calls = rawCalls.map((row) => merge(row, "call"));
  const puts = rawPuts.map((row) => merge(row, "put"));

  const tradeDate = options.tradeDate ?? qfq.at(-1)?.date ?? null;
  const underlying = qfq.at(-1)
    ? {
        date: qfq.at(-1).date,
        close: qfq.at(-1).close,
        qfqClose: qfq.at(-1).close,
        rawClose: raw.at(-1)?.close ?? null,
      }
    : null;

  // Eastmoney has no expiry date field in the list payload; derive it from names + Sina expiries.
  const chain = { code: options.code, tradeDate, underlying, calls, puts };
  await writeFile(path.join(outDir, "kline-qfq.json"), JSON.stringify({ code: options.code, fq: "qfq", rows: qfq }, null, 1));
  await writeFile(path.join(outDir, "kline-normal.json"), JSON.stringify({ code: options.code, fq: "normal", rows: raw }, null, 1));
  await writeFile(path.join(outDir, "option-chain.json"), JSON.stringify(chain, null, 1));

  const expiries = new Map();
  for (const c of [...calls, ...puts]) {
    if (!c.expiry) continue;
    const key = c.expiry;
    expiries.set(key, (expiries.get(key) ?? 0) + 1);
  }
  console.log(
    JSON.stringify(
      {
        outDir,
        code: options.code,
        tradeDate,
        underlyingClose: underlying,
        klineRows: { qfq: qfq.length, normal: raw.length },
        contracts: { calls: calls.length, puts: puts.length },
        expiries: Object.fromEntries([...expiries].sort()),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(`fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
