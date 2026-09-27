#!/usr/bin/env node

// Sync the complete CSI index constituent set into the local stock identity
// tables. Eastmoney supplies both the constituent list and EM2016 taxonomy.
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { LOCAL_SQLITE_CONNECTION_PRAGMAS, resolveExistingLocalD1Database } from "./lib/local-d1-sqlite.mjs";

const INDEX_ENDPOINT = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const PROFILE_ENDPOINT = "https://datacenter.eastmoney.com/securities/api/data/v1/get";
const INDEX_COUNTS = new Map([["000906", 800], ["000852", 1000]]);
const ALIAS_SOURCE = "eastmoney_csi_constituent";
const options = parseOptions(process.argv.slice(2));

const indexes = await Promise.all(options.indexes.map(fetchIndex));
const constituentByCode = new Map();
for (const index of indexes) {
  for (const item of index.rows) {
    const previous = constituentByCode.get(item.code);
    if (previous && previous.name !== item.name) {
      throw new Error(`conflicting names for ${item.code}: ${previous.name} / ${item.name}`);
    }
    constituentByCode.set(item.code, item);
  }
}

const constituents = [...constituentByCode.values()].sort((a, b) => a.code.localeCompare(b.code, "en"));
const profiles = await fetchProfiles(constituents, options.batchSize, options.concurrency);
const databaseFile = resolveExistingLocalD1Database({ path: options.dbPath });
const db = new DatabaseSync(databaseFile);
try {
  db.exec(LOCAL_SQLITE_CONNECTION_PRAGMAS.join("\n"));
  assertSchema(db);
  const existing = new Map(db.prepare(`select code, short_name, industry_level_1, industry_level_2, industry_level_3
    from stock`).all().map((row) => [row.code, row]));
  const changed = profiles.filter((profile) => {
    const old = existing.get(profile.code);
    return !old || profile.levels.some((level, i) => level !== old[`industry_level_${i + 1}`]);
  }).length;
  const newStocks = profiles.filter((profile) => !existing.has(profile.code)).length;

  if (options.apply) writeStocks(db, profiles);

  const classified = options.apply ? db.prepare(`select count(*) as n from stock
    where industry_level_1 is not null and industry_level_2 is not null and industry_level_3 is not null`).get().n : null;
  console.log(JSON.stringify({
    mode: options.apply ? "applied" : "dry-run",
    database: databaseFile,
    indexes: indexes.map(({ code, name, rows }) => ({ code, name, constituents: rows.length })),
    uniqueStocks: profiles.length,
    newStocks,
    changedIndustryRows: changed,
    classifiedStocksAfterApply: classified,
    aliasKinds: ["eastmoney_name"],
  }, null, 2));
} finally {
  db.close();
}

function parseOptions(argv) {
  const options = { apply: false, indexes: ["000906", "000852"], batchSize: 80, concurrency: 4, dbPath: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--indexes") options.indexes = requiredValue(argv, ++i, arg).split(",").map((s) => s.trim());
    else if (arg === "--batch-size") options.batchSize = Number(requiredValue(argv, ++i, arg));
    else if (arg === "--concurrency") options.concurrency = Number(requiredValue(argv, ++i, arg));
    else if (arg === "--db") options.dbPath = resolve(requiredValue(argv, ++i, arg));
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/sync-csi-stock-universe.mjs [--apply] [--indexes 000906,000852] [--batch-size 80] [--concurrency 4] [--db PATH]\nWithout --apply, fetches and validates live data but does not write. LOCAL_DB_PATH is also supported.");
      process.exit(0);
    } else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.indexes.length || new Set(options.indexes).size !== options.indexes.length || options.indexes.some((s) => !/^\d{6}$/.test(s))) {
    throw new Error("--indexes requires unique six-digit CSI index codes");
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100) throw new Error("--batch-size must be 1–100");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 12) throw new Error("--concurrency must be 1–12");
  return options;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function fetchIndex(code) {
  const rows = [];
  let page = 1;
  let count = 0;
  let name = "";
  do {
    const url = new URL(INDEX_ENDPOINT);
    for (const [key, value] of Object.entries({
      reportName: "RPT_INDEX_CONSTITUENT",
      columns: "SECUCODE,SECURITY_NAME_ABBR,INDEX_CODE,INDEX_NAME",
      filter: `(INDEX_CODE="${code}")`,
      pageNumber: String(page),
      pageSize: "2000",
      source: "WEB",
      client: "WEB",
    })) url.searchParams.set(key, value);
    const body = await fetchJson(url);
    if (body.success !== true || !Array.isArray(body.result?.data)) throw new Error(`index ${code} page ${page}: ${body.message || "invalid response"}`);
    count = Number(body.result.count);
    for (const row of body.result.data) {
      const item = { code: String(row.SECUCODE || "").trim().toUpperCase(), name: String(row.SECURITY_NAME_ABBR || "").trim() };
      if (!/^\d{6}\.(?:SH|SZ|BJ)$/.test(item.code) || !item.name || row.INDEX_CODE !== code) {
        throw new Error(`index ${code} contains an invalid constituent: ${JSON.stringify(row)}`);
      }
      name = String(row.INDEX_NAME || "").trim() || name;
      rows.push(item);
    }
    page += 1;
    if (page > 20) throw new Error(`index ${code} exceeds 20 pages`);
  } while (rows.length < count);
  if (!count || rows.length !== count || new Set(rows.map((row) => row.code)).size !== count) {
    throw new Error(`index ${code} incomplete or duplicated: expected ${count}, received ${rows.length}`);
  }
  if (INDEX_COUNTS.has(code) && count !== INDEX_COUNTS.get(code)) {
    throw new Error(`index ${code} expected ${INDEX_COUNTS.get(code)} constituents, received ${count}`);
  }
  return { code, name, rows };
}

async function fetchProfiles(constituents, batchSize, concurrency) {
  const batches = [];
  for (let i = 0; i < constituents.length; i += batchSize) batches.push(constituents.slice(i, i + batchSize));
  const profiles = new Map();
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++];
      const url = new URL(PROFILE_ENDPOINT);
      for (const [key, value] of Object.entries({
        reportName: "RPT_F10_ORG_BASICINFO",
        columns: "SECUCODE,SECURITY_NAME_ABBR,EM2016",
        quoteColumns: "",
        filter: `(SECUCODE in (${batch.map(({ code }) => `"${code}"`).join(",")}))`,
        pageNumber: "1",
        pageSize: String(batch.length),
        source: "HSF10",
        client: "PC",
      })) url.searchParams.set(key, value);
      const body = await fetchJson(url, { Referer: "https://emweb.securities.eastmoney.com/" });
      const rows = body.result?.data;
      if (body.success !== true || !Array.isArray(rows) || Number(body.result.count) !== batch.length || rows.length !== batch.length) {
        throw new Error(`EM2016 batch ${batch[0].code}–${batch.at(-1).code}: expected ${batch.length}, received ${rows?.length ?? 0}: ${body.message || ""}`);
      }
      const expected = new Set(batch.map(({ code }) => code));
      for (const row of rows) {
        const code = String(row.SECUCODE || "").trim().toUpperCase();
        const name = String(row.SECURITY_NAME_ABBR || "").trim();
        const levels = String(row.EM2016 || "").split("-").map((value) => value.trim());
        if (!expected.delete(code) || !name || levels.length !== 3 || levels.some((value) => !value)) {
          throw new Error(`missing or malformed EM2016 profile for ${code}: ${JSON.stringify(row)}`);
        }
        profiles.set(code, { code, name, levels });
      }
      if (expected.size) throw new Error(`missing EM2016 profiles: ${[...expected].join(", ")}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  if (profiles.size !== constituents.length) throw new Error(`profile coverage ${profiles.size}/${constituents.length}`);
  return constituents.map(({ code }) => profiles.get(code));
}

async function fetchJson(url, headers = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw new Error(`request failed: ${url.origin}${url.pathname}: ${lastError?.message || lastError}`);
}

function assertSchema(db) {
  for (const [table, required] of [
    ["stock", ["code", "short_name", "updated_at", "industry_level_1", "industry_level_2", "industry_level_3"]],
    ["stock_alias", ["alias", "code", "source", "updated_at"]],
  ]) {
    const actual = new Set(db.prepare(`pragma table_info(${table})`).all().map((row) => row.name));
    for (const column of required) if (!actual.has(column)) throw new Error(`run local migrations first: ${table}.${column} is missing`);
  }
}

function writeStocks(db, profiles) {
  const now = Date.now();
  const stock = db.prepare(`insert into stock (code, short_name, industry_level_1, industry_level_2, industry_level_3, updated_at)
    values (?, ?, ?, ?, ?, ?)
    on conflict(code) do update set
      industry_level_1=excluded.industry_level_1,
      industry_level_2=excluded.industry_level_2,
      industry_level_3=excluded.industry_level_3
    where stock.industry_level_1 is not excluded.industry_level_1
       or stock.industry_level_2 is not excluded.industry_level_2
       or stock.industry_level_3 is not excluded.industry_level_3`);
  const alias = db.prepare(`insert into stock_alias (alias, code, source, updated_at)
    values (?, ?, ?, ?) on conflict(alias, code) do nothing`);
  const storedStock = db.prepare(`select industry_level_1, industry_level_2, industry_level_3
    from stock where code = ?`);
  const storedAlias = db.prepare(`select 1 from stock_alias where alias = ? and code = ?`);
  db.exec("begin immediate");
  try {
    for (const { code, name, levels } of profiles) {
      stock.run(code, name, ...levels, now);
      alias.run(name.toLowerCase(), code, ALIAS_SOURCE, now);
    }
    for (const { code, name, levels } of profiles) {
      const row = storedStock.get(code);
      if (!row || levels.some((level, i) => level !== row[`industry_level_${i + 1}`])) {
        throw new Error(`failed to verify stock industry: ${code}`);
      }
      if (!storedAlias.get(name.toLowerCase(), code)) throw new Error(`failed to verify stock name: ${name} -> ${code}`);
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
