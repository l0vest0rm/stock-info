#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeLocalD1SqlFile } from "./lib/local-d1-sqlite.mjs";

const SOURCE = "curated_asia_popular";
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node scripts/sync-asia-popular-stocks.mjs [--dry-run] [--remote] [--database stock_info] [--manifest path/to/stocks.json]\n\nDefault: upsert config/asia-popular-stocks.json into the migrated local SQLite database. --remote explicitly writes to Cloudflare D1. Existing identities and aliases are preserved.");
  process.exit(0);
}
const remote = args.includes("--remote");
const dryRun = args.includes("--dry-run");
const database = option("--database") || "stock_info";
const manifest = resolve(option("--manifest") || new URL("../config/asia-popular-stocks.json", import.meta.url).pathname);
const unknown = args.filter((arg, index) => !["--remote", "--dry-run", "--database", "--manifest"].includes(arg) && !["--database", "--manifest"].includes(args[index - 1]));
if (unknown.length) throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
if (!/^[a-zA-Z0-9_-]+$/.test(database)) throw new Error("Invalid D1 database name");

const stocks = parseManifest(JSON.parse(readFileSync(manifest, "utf8")));
const now = Date.now();
const statements = stocks.flatMap(({ code, name, aliases }) => [
  `insert into stock (code, short_name, updated_at) values (${q(code)}, ${q(name)}, ${now}) on conflict(code) do nothing;`,
  ...[...new Set([name, ...aliases].map((value) => value.trim().toLowerCase()))]
    .filter((alias) => alias !== code.toLowerCase() && alias !== code.slice(0, code.lastIndexOf(".")).toLowerCase())
    .map((alias) => `insert into stock_alias (alias, code, source, updated_at) values (${q(alias)}, ${q(code)}, ${q(SOURCE)}, ${now}) on conflict(alias, code) do nothing;`),
]);

if (!dryRun) {
  const dir = mkdtempSync(join(tmpdir(), "stock-info-asia-stocks-"));
  const file = join(dir, "upsert.sql");
  try {
    writeFileSync(file, `${statements.join("\n")}\n`);
    if (remote) {
      execFileSync("npx", ["wrangler", "d1", "execute", database, "--remote", "--file", file], { stdio: "inherit" });
    } else {
      executeLocalD1SqlFile(file, { requiredTable: "stock_alias" });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ manifest, target: dryRun ? "dry-run" : remote ? `remote:${database}` : "local", korean: stocks.filter((stock) => stock.code.endsWith(".KS")).length, japanese: stocks.filter((stock) => stock.code.endsWith(".T")).length, statements: statements.length }));

function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return "";
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

function parseManifest(payload) {
  if (!Array.isArray(payload?.stocks) || payload.stocks.length === 0) throw new Error("Manifest requires nonempty stocks array");
  const codes = new Set();
  return payload.stocks.map((item) => {
    const code = String(item?.code || "").trim().toUpperCase();
    const name = String(item?.name || "").trim();
    const aliases = item?.aliases;
    if (!/^(?:\d{6}\.KS|\d{4}\.T)$/.test(code) || !name || !Array.isArray(aliases)
      || aliases.some((alias) => typeof alias !== "string" || !alias.trim()) || codes.has(code)) {
      throw new Error(`Invalid or duplicate stock identity: ${JSON.stringify(item)}`);
    }
    codes.add(code);
    return { code, name, aliases };
  });
}

function q(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
