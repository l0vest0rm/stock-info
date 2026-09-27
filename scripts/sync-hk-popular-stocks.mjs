#!/usr/bin/env node

// Maintain a repeatable HK stock identity universe from Eastmoney's main-board
// market-cap and turnover rankings. This is not a historical index membership.
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { LOCAL_SQLITE_CONNECTION_PRAGMAS, resolveExistingLocalD1Database } from "./lib/local-d1-sqlite.mjs";

const ENDPOINT = "https://push2.eastmoney.com/webguest/api/qt/clist/get";
const ALIAS_SOURCE = "eastmoney_hk_popular";
const PAGE_SIZE = 100; // Eastmoney caps the clist response at 100 rows.
const options = parseOptions(process.argv.slice(2));

const [largest, mostTraded] = await Promise.all([
  fetchRankedStocks("f20", options.marketCapCount),
  fetchRankedStocks("f6", options.turnoverCount),
]);
const stocks = [...new Map([...largest, ...mostTraded].map((item) => [item.code, item])).values()]
  .sort((a, b) => a.code.localeCompare(b.code, "en"));
const databaseFile = resolveExistingLocalD1Database({ path: options.dbPath });
const db = new DatabaseSync(databaseFile);
try {
  db.exec(LOCAL_SQLITE_CONNECTION_PRAGMAS.join("\n"));
  assertSchema(db);
  const existing = new Set(db.prepare("select code from stock where code like '%.HK'").all().map((row) => row.code));
  if (options.apply) writeStocks(db, stocks);
  console.log(JSON.stringify({
    mode: options.apply ? "applied" : "dry-run",
    database: databaseFile,
    source: "Eastmoney HK main-board market-cap and turnover rankings",
    marketCapCount: largest.length,
    turnoverCount: mostTraded.length,
    uniqueStocks: stocks.length,
    newStocks: stocks.filter(({ code }) => !existing.has(code)).length,
    excluded: "RMB duplicate counters (8xxxx.HK) and GEM stocks",
    industry: "not set: HK f100 is not the mainland EM2016 three-level taxonomy",
  }, null, 2));
} finally {
  db.close();
}

function parseOptions(argv) {
  const options = { apply: false, marketCapCount: 200, turnoverCount: 100, dbPath: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--market-cap-count") options.marketCapCount = Number(requiredValue(argv, ++i, arg));
    else if (arg === "--turnover-count") options.turnoverCount = Number(requiredValue(argv, ++i, arg));
    else if (arg === "--db") options.dbPath = resolve(requiredValue(argv, ++i, arg));
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/sync-hk-popular-stocks.mjs [--apply] [--market-cap-count 200] [--turnover-count 100] [--db PATH]\nWithout --apply, validates live Eastmoney rankings but does not write. LOCAL_DB_PATH is also supported.");
      process.exit(0);
    } else throw new Error(`unknown option: ${arg}`);
  }
  for (const count of [options.marketCapCount, options.turnoverCount]) {
    if (!Number.isInteger(count) || count < 0 || count > 1000) throw new Error("ranking counts must be integers from 0 to 1000");
  }
  if (options.marketCapCount + options.turnoverCount === 0) throw new Error("select at least one ranking");
  return options;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function fetchRankedStocks(field, wanted) {
  if (!wanted) return [];
  const stocks = [];
  const seen = new Set();
  let previousMetric = Infinity;
  for (let page = 1; stocks.length < wanted && page <= 20; page += 1) {
    const url = new URL(ENDPOINT);
    for (const [key, value] of Object.entries({
      pn: String(page), pz: String(PAGE_SIZE), po: "1", np: "1", fltt: "2", invt: "2",
      fid: field, fields: "f12,f13,f14,f20,f6",
      fs: "m:116+t:3", // HK main board equities, excluding GEM.
      ut: "fa5fd1943c7b386f172d6893dbfba10b",
      wbp2u: "|0|0|0|web",
    })) url.searchParams.set(key, value);
    const body = await fetchJson(url);
    const rows = body.data?.diff;
    if (body.rc !== 0 || !Array.isArray(rows) || !Number.isInteger(body.data?.total) || body.data.total < wanted) {
      throw new Error(`Eastmoney HK ${field} page ${page}: incomplete ranking`);
    }
    if (!rows.length) throw new Error(`Eastmoney HK ${field} page ${page}: empty page before ${wanted} stocks`);
    for (const row of rows) {
      const code = String(row.f12 ?? "").trim();
      const name = String(row.f14 ?? "").trim();
      const metric = Number(row[field]);
      const marketCap = Number(row.f20);
      if (!/^\d{5}$/.test(code) || !name || row.f13 !== 116 || !Number.isFinite(metric) || metric < 0) {
        throw new Error(`invalid HK stock in ${field} ranking: ${JSON.stringify(row)}`);
      }
      if (metric > previousMetric) throw new Error(`HK ${field} ranking is not descending at ${code}`);
      previousMetric = metric;
      if (seen.has(code)) throw new Error(`duplicate HK code in ${field} ranking: ${code}`);
      seen.add(code);
      // 8xxxx are RMB settlement counters for the same underlying stocks.
      if (code.startsWith("8") || !Number.isFinite(marketCap) || marketCap <= 0 || (field === "f6" && metric === 0)) continue;
      stocks.push({ code: `${code}.HK`, name });
      if (stocks.length === wanted) break;
    }
  }
  if (stocks.length !== wanted) throw new Error(`HK ${field} ranking incomplete: ${stocks.length}/${wanted}`);
  return stocks;
}

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Referer: "https://quote.eastmoney.com/", "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw new Error(`Eastmoney HK ranking request failed: ${lastError?.message || lastError}`);
}

function assertSchema(db) {
  for (const [table, required] of [
    ["stock", ["code", "short_name", "updated_at"]],
    ["stock_alias", ["alias", "code", "source", "updated_at"]],
  ]) {
    const actual = new Set(db.prepare(`pragma table_info(${table})`).all().map((row) => row.name));
    for (const column of required) if (!actual.has(column)) throw new Error(`run local migrations first: ${table}.${column} is missing`);
  }
}

function writeStocks(db, stocks) {
  const now = Date.now();
  const stock = db.prepare(`insert into stock (code, short_name, updated_at)
    values (?, ?, ?) on conflict(code) do nothing`);
  const alias = db.prepare(`insert into stock_alias (alias, code, source, updated_at)
    values (?, ?, ?, ?) on conflict(alias, code) do nothing`);
  const storedStock = db.prepare("select 1 from stock where code = ?");
  const storedAlias = db.prepare("select 1 from stock_alias where alias = ? and code = ?");
  db.exec("begin immediate");
  try {
    for (const { code, name } of stocks) {
      stock.run(code, name, now);
      alias.run(name.toLowerCase(), code, ALIAS_SOURCE, now);
    }
    for (const { code, name } of stocks) {
      if (!storedStock.get(code)) throw new Error(`failed to verify HK stock: ${code}`);
      if (!storedAlias.get(name.toLowerCase(), code)) throw new Error(`failed to verify HK stock name: ${name} -> ${code}`);
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
