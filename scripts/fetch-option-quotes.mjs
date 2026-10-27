#!/usr/bin/env node
/**
 * Attach top-of-book (bid1/ask1) quotes for the option contracts in a cached chain.
 *
 * Sina's CON_OP feed is the only convenient free source with live bid/ask for SSE
 * ETF options; its layout is positional, so the indices used here are verified
 * against known-good samples in docs/research/covered-call-588000/README.md.
 *
 * Layout (0-based) of `hq_str_CON_OP_<code>`:
 *   [1] last  [7] strike  [12] ask1  [20] ask5  [22] bid1  [30] bid5
 *   [32] quote time  [37] name  [39] day high  [40] day low
 *   [41] volume(lots)  [42] amount  [46] expiry date  [49]/[50] vendor risk metrics
 *
 * Usage:
 *   node scripts/fetch-option-quotes.mjs --dir data/research/covered-call-588000
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";

function parseArgs(argv) {
  const options = { dir: "data/research/covered-call-588000" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--dir") options.dir = next();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function parseQuote(line) {
  const p = line.split(",");
  const num = (i) => {
    const v = Number(p[i]);
    return Number.isFinite(v) ? v : null;
  };
  return {
    last: num(1),
    strike: num(7),
    ask1: num(12),
    bid1: num(22),
    quoteTime: p[32] ?? null,
    name: p[37] ?? null,
    high: num(39),
    low: num(40),
    volumeLots: num(41),
    amount: num(42),
    expiry: /^\d{4}-\d{2}-\d{2}$/.test(p[46] ?? "") ? p[46] : null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("node scripts/fetch-option-quotes.mjs [--dir data/research/covered-call-588000]");
    return;
  }
  const dir = path.resolve(options.dir);
  const chainPath = path.join(dir, "option-chain.json");
  const chain = JSON.parse(await readFile(chainPath, "utf8"));

  const codes = [
    ...chain.calls.filter((c) => c.expiry && c.lastPrice > 0).map((c) => c.code),
    ...chain.puts.filter((c) => c.expiry && c.lastPrice > 0).map((c) => c.code),
  ];
  const quotes = new Map();
  const batchSize = 25;
  for (let i = 0; i < codes.length; i += batchSize) {
    const batch = codes.slice(i, i + batchSize);
    const url = `https://hq.sinajs.cn/list=${batch.map((c) => `CON_OP_${c}`).join(",")}`;
    const response = await fetch(url, {
      headers: { "User-Agent": UA, Referer: "https://finance.sina.com.cn" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`sina HTTP ${response.status}`);
    const text = new TextDecoder("gbk").decode(new Uint8Array(await response.arrayBuffer()));
    for (const line of text.split("\n")) {
      const match = /hq_str_CON_OP_(\d+)="([^"]*)"/.exec(line);
      if (!match || !match[2]) continue;
      quotes.set(match[1], parseQuote(match[2]));
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  for (const contract of [...chain.calls, ...chain.puts]) {
    const q = quotes.get(contract.code);
    if (!q) continue;
    contract.quote = q;
    // A buyer pays the ask, a seller receives the bid. Both sides are kept so each
    // strategy is priced from the correct side of the book, never from mid or last.
    const bid = q.bid1;
    const ask = q.ask1;
    contract.executableBid = bid !== null && bid > 0 ? bid : null;
    contract.executableAsk = ask !== null && ask > 0 ? ask : null;
    contract.executableMid = bid !== null && ask !== null && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  }

  const withCallQuotes = chain.calls.filter((c) => c.quote).length;
  const withPutQuotes = chain.puts.filter((c) => c.quote).length;
  await writeFile(chainPath, JSON.stringify(chain, null, 1));
  await writeFile(
    path.join(dir, "quotes-snapshot.json"),
    JSON.stringify({ fetchedAt: new Date().toISOString(), count: quotes.size, quotes: Object.fromEntries(quotes) }, null, 1)
  );
  console.log(`quotes attached: calls ${withCallQuotes}/${chain.calls.length}, puts ${withPutQuotes}/${chain.puts.length}`);
}

main().catch((error) => {
  console.error(`quote fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
