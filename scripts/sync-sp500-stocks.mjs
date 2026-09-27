#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeLocalD1SqlFile } from "./lib/local-d1-sqlite.mjs";

// This maintained CSV mirrors Wikipedia's S&P 500 constituents table. It has
// one row per share class, so the count can be slightly greater than 500.
const SOURCE_URL = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
const SOURCE = "sp500_constituents";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node scripts/sync-sp500-stocks.mjs [--dry-run] [--remote] [--database stock_info] [--input path/to/constituents.csv]\n\nDefault: fetch the current CSV and upsert into the migrated local SQLite database. --remote writes to Cloudflare D1 instead. --input reads a saved CSV for reproducible/offline runs. No existing stocks or aliases are deleted.");
  process.exit(0);
}
const remote = args.includes("--remote");
const dryRun = args.includes("--dry-run");
const database = option("--database") || "stock_info";
const input = option("--input");
const unknown = args.filter((arg, index) => !["--remote", "--dry-run", "--database", "--input"].includes(arg) && !["--database", "--input"].includes(args[index - 1]));
if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
if (!/^[a-zA-Z0-9_-]+$/.test(database)) throw new Error("Invalid D1 database name");

const csv = input ? readFileSync(input, "utf8") : await fetchCsv();
const rows = parseConstituents(csv);
const now = Date.now();
const statements = rows.flatMap(({ symbol, name }) => {
  const code = `${symbol}.US`;
  const aliases = new Set([name.trim().toLowerCase()]);
  return [
    // Existing canonical names may be curated by other importers; do not replace them.
    `insert into stock (code, short_name, updated_at) values (${q(code)}, ${q(name)}, ${now}) on conflict(code) do nothing;`,
    ...[...aliases].map((alias) =>
      `insert into stock_alias (alias, code, source, updated_at) values (${q(alias)}, ${q(code)}, ${q(SOURCE)}, ${now}) on conflict(alias, code) do nothing;`
    ),
  ];
});

if (!dryRun) {
  // Wrangler's execute request has a smaller practical input limit than local
  // sqlite3. Each bounded batch is idempotent if a later batch fails.
  const batchSize = remote ? 240 : statements.length;
  for (let offset = 0; offset < statements.length; offset += batchSize) {
    const dir = mkdtempSync(join(tmpdir(), "stock-info-sp500-"));
    const file = join(dir, "upsert.sql");
    try {
      writeFileSync(file, `${statements.slice(offset, offset + batchSize).join("\n")}\n`);
      if (remote) {
        execFileSync("npx", ["wrangler", "d1", "execute", database, "--remote", "--file", file], { stdio: "inherit" });
      } else {
        executeLocalD1SqlFile(file, { requiredTable: "stock_alias" });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
console.log(JSON.stringify({ source: input || SOURCE_URL, target: dryRun ? "dry-run" : remote ? `remote:${database}` : "local", securities: rows.length, statements: statements.length }));

function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return "";
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

async function fetchCsv() {
  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`S&P 500 source returned HTTP ${response.status}`);
  return response.text();
}

function parseConstituents(csv) {
  const records = parseCsv(csv.replace(/^\uFEFF/, ""));
  const header = records.shift();
  const symbolIndex = header?.indexOf("Symbol") ?? -1;
  const nameIndex = header?.indexOf("Security") ?? -1;
  if (symbolIndex < 0 || nameIndex < 0) throw new Error("Source CSV is missing Symbol or Security column");
  const seen = new Set();
  const rows = records.filter((row) => row.some((cell) => cell.trim())).map((row) => {
    const symbol = row[symbolIndex]?.trim().toUpperCase();
    const name = row[nameIndex]?.trim();
    if (!/^[A-Z][A-Z0-9]*(?:\.[A-Z0-9]+)?$/.test(symbol || "") || !name || seen.has(symbol)) {
      throw new Error(`Invalid or duplicate constituent: ${JSON.stringify(row)}`);
    }
    seen.add(symbol);
    return { symbol, name };
  });
  if (rows.length < 450 || rows.length > 550) throw new Error(`Unexpected S&P 500 constituent count: ${rows.length}; refusing partial import`);
  return rows;
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field); field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      row.push(field); rows.push(row); row = []; field = "";
      if (char === "\r" && csv[i + 1] === "\n") i += 1;
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("Unterminated quoted CSV field");
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function q(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
