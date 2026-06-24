import { Hono } from "hono";
import { fetchJson, ok } from "../shared/http";
import type { AppEnv } from "../types";

export const optionsRoutes = new Hono<AppEnv>();

type OptionChain = {
  code: string;
  symbol: string;
  currentPrice: number;
  expirations: Array<Record<string, unknown>>;
};

optionsRoutes.get("/options/us", async (c) => {
  const code = (c.req.query("code") ?? "").trim().toUpperCase();
  const symbol = code.replace(/\.US$/, "");
  if (!symbol || symbol === code) {
    return ok(c, { code, symbol, currentPrice: 0, expirations: [] });
  }
  for (const assetClass of ["stocks", "etf"]) {
    const chain = await fetchNasdaqOptionChain(code, symbol, assetClass).catch(() => null);
    if (chain && chain.expirations.length > 0) {
      return ok(c, chain);
    }
  }
  return ok(c, { code, symbol, currentPrice: 0, expirations: [] });
});

async function fetchNasdaqOptionChain(code: string, symbol: string, assetClass: string): Promise<OptionChain> {
  const firstUrl = new URL(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/option-chain`);
  firstUrl.searchParams.set("assetclass", assetClass);
  firstUrl.searchParams.set("limit", "60");
  const first = (await fetchNasdaq(firstUrl)) as any;
  const dates = first.data?.filterlist?.fromdate?.filter?.map((item: any) => String(item.value || "")).filter(Boolean) ?? [];
  const currentPrice = parseMoney(first.data?.lastTrade);
  const expirations = [];
  for (const date of dates.slice(0, 8)) {
    const url = new URL(firstUrl);
    url.searchParams.set("fromdate", date);
    const body = (await fetchNasdaq(url)) as any;
    const rows = body.data?.table?.rows ?? [];
    const calls = [];
    const puts = [];
    for (const row of rows) {
      const strike = parseMoney(row.strike);
      if (!Number.isFinite(strike)) continue;
      calls.push(contract(symbol, "call", date, strike, row, "c_"));
      puts.push(contract(symbol, "put", date, strike, row, "p_"));
    }
    expirations.push({ date, calls, puts });
  }
  return { code, symbol, currentPrice, expirations };
}

async function fetchNasdaq(url: URL): Promise<unknown> {
  return fetchJson(url.toString(), {
    headers: {
      Accept: "application/json, text/plain, */*",
      Origin: "https://www.nasdaq.com",
      Referer: "https://www.nasdaq.com/",
    },
  });
}

function contract(symbol: string, type: "call" | "put", expiration: string, strike: number, row: any, prefix: "c_" | "p_"): Record<string, unknown> {
  const last = parseMoney(row[`${prefix}Last`]);
  const bid = parseMoney(row[`${prefix}Bid`]);
  const ask = parseMoney(row[`${prefix}Ask`]);
  return {
    symbol: `${symbol}-${expiration}-${type}-${strike}`,
    type,
    expiration,
    strike,
    last,
    bid,
    ask,
    price: mid(last, bid, ask),
    volume: parseIntSafe(row[`${prefix}Volume`]),
    openInterest: parseIntSafe(row[`${prefix}Openinterest`]),
  };
}

function mid(last: number, bid: number, ask: number): number {
  if (bid > 0 && ask > 0) return Number(((bid + ask) / 2).toFixed(2));
  return last;
}

function parseMoney(value: unknown): number {
  const num = Number(String(value ?? "").replace(/[$,%+,]/g, "").trim());
  return Number.isFinite(num) ? num : 0;
}

function parseIntSafe(value: unknown): number {
  const num = Number.parseInt(String(value ?? "").replace(/,/g, ""), 10);
  return Number.isFinite(num) ? num : 0;
}
