#!/usr/bin/env node

/**
 * Read-only P0/P6 evidence collector. It never opens Wrangler or writes either
 * database; the optional report files are the only output side effect.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(new URL("..", import.meta.url).pathname);
const now = new Date();
const stamp = now.toISOString().replaceAll(":", "").replace(/\.\d{3}Z$/, "Z");
const output = resolve(readArg("--output") || join(root, "docs/runtime-audits", `local-runtime-${stamp}.md`));
const jsonOutput = output.replace(/\.md$/i, ".json");
const localPath = resolve(process.env.LOCAL_DB_PATH || join(root, process.env.LOCAL_DATA_DIR || "data/local", "stock-info.sqlite"));
const miniflareRoot = resolve(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
const scopes = [
  ["securities", "securities"],
  ["kline", "kline_bars"],
  ["knowledge documents", "knowledge_docs"],
  ["knowledge processing tasks", "llm_tasks"],
  ["knowledge processing runs", "llm_runs"],
  ["knowledge processing artifacts", "llm_run_artifacts"],
  ["legacy knowledge processing jobs", "information_processing_jobs"],
  ["research web search", "research_web_search_package_jobs"],
  ["research operating analysis", "research_operating_analysis_jobs"],
  ["macro", "macro_series"],
  ["situation", "situation_events"],
];

if (!existsSync(localPath)) throw new Error(`LOCAL_DB_PATH does not exist: ${localPath}`);
const local = new DatabaseSync(localPath, { open: true, readOnly: true });
const miniflareCandidates = existsSync(miniflareRoot)
  ? readdirSync(miniflareRoot).filter((name) => name.endsWith(".sqlite")).map((name) => join(miniflareRoot, name))
  : [];
const miniflareInventories = miniflareCandidates.map(inventory).sort((a, b) => b.tables.length - a.tables.length || a.file.localeCompare(b.file));
const canonicalMiniflare = miniflareInventories[0] ?? null;
const legacy = canonicalMiniflare ? new DatabaseSync(canonicalMiniflare.file, { open: true, readOnly: true }) : null;

const report = {
  collectedAt: now.toISOString(),
  commands: ["node scripts/audit-local-runtime.mjs --output <report.md>", "tar -tzf <retired-state.tar.gz>"],
  localDb: inspectDatabase(local, localPath),
  miniflareDatabases: miniflareInventories,
  canonicalMiniflare: canonicalMiniflare?.file ?? null,
  scopes: Object.fromEntries(scopes.map(([label, table]) => [label, compareTable(local, legacy, table)])),
  runtime: inspectRuntime(),
  decision: {
    local: "migrate: canonical local Node SQLite data source",
    miniflare: "archive: preserve .wrangler/state backup until P6 confirms no local command accesses it; do not import historical Miniflare rows into Node SQLite",
  },
};
local.close();
legacy?.close();
await mkdir(dirname(output), { recursive: true });
writeFileSync(jsonOutput, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(output, renderMarkdown(report, jsonOutput));
console.log(`Local runtime audit written: ${output}`);

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function inventory(file) {
  const db = new DatabaseSync(file, { open: true, readOnly: true });
  try {
    return { file, bytes: statSync(file).size, tables: tableNames(db) };
  } finally {
    db.close();
  }
}

function inspectDatabase(db, file) {
  const tables = tableNames(db);
  return {
    file,
    bytes: statSync(file).size,
    tables: Object.fromEntries(tables.map((table) => [table, tableStats(db, table)])),
  };
}

function tableNames(db) {
  return db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all().map((row) => String(row.name));
}

function tableStats(db, table) {
  const columns = columnsFor(db, table);
  const dateColumns = columns.filter((column) => /(?:_at|_time|date)$/i.test(column.name)).map((column) => column.name);
  return {
    schema: String(db.prepare("select sql from sqlite_master where type = 'table' and name = ?").get(table)?.sql || ""),
    rowCount: numeric(db.prepare(`select count(*) as count from ${identifier(table)}`).get()?.count),
    maxTimestamp: Object.fromEntries(dateColumns.map((column) => [column, db.prepare(`select max(${identifier(column)}) as value from ${identifier(table)}`).get()?.value ?? null])),
    primaryKey: columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name),
  };
}

function compareTable(localDb, legacyDb, table) {
  const localHas = hasTable(localDb, table);
  const legacyHas = Boolean(legacyDb && hasTable(legacyDb, table));
  const localStats = localHas ? tableStats(localDb, table) : null;
  const legacyStats = legacyHas ? tableStats(legacyDb, table) : null;
  const primaryKey = localStats?.primaryKey || legacyStats?.primaryKey || [];
  const comparable = Boolean(localHas && legacyHas && primaryKey.length && primaryKey.every((key) => columnsFor(legacyDb, table).some((column) => column.name === key)));
  return {
    table,
    local: localStats,
    miniflare: legacyStats,
    onlyInLocal: comparable ? onlyKeyCount(localDb, legacyDb, table, primaryKey) : null,
    onlyInMiniflare: comparable ? onlyKeyCount(legacyDb, localDb, table, primaryKey) : null,
    comparisonNote: comparable ? "Primary-key rows compared read-only." : "No compatible declared primary key; schema/count/timestamp inventory only.",
  };
}

function onlyKeyCount(left, right, table, keys) {
  const values = new Set(right.prepare(`select ${keys.map(identifier).join(", ")} from ${identifier(table)}`).all().map((row) => keys.map((key) => JSON.stringify(row[key])).join("\u001f")));
  let only = 0;
  for (const row of left.prepare(`select ${keys.map(identifier).join(", ")} from ${identifier(table)}`).iterate()) {
    if (!values.has(keys.map((key) => JSON.stringify(row[key])).join("\u001f"))) only += 1;
  }
  return only;
}

function columnsFor(db, table) {
  return db.prepare(`pragma table_info(${identifier(table)})`).all().map((row) => ({ name: String(row.name), pk: numeric(row.pk) }));
}

function hasTable(db, table) {
  return Boolean(db?.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table));
}

function inspectRuntime() {
  const processes = command("ps", ["-axo", "pid=,ppid=,lstart=,command="])
    .split("\n").filter((line) => /stock-info|research-web-search|research-operating|information-processing|knowledge-ingest|local-cron|wrangler|watchdog/i.test(line));
  const listeners = command("lsof", ["-nP", "-iTCP:8000", "-iTCP:8788", "-iTCP:8791", "-sTCP:LISTEN"])
    .split("\n").filter(Boolean);
  const logRoot = join(root, "data/logs");
  const logs = existsSync(logRoot) ? readdirSync(logRoot).filter((name) => statSync(join(logRoot, name)).isFile()).map((name) => ({ name, bytes: statSync(join(logRoot, name)).size })).sort((a, b) => b.bytes - a.bytes) : [];
  return { processes, listeners, logs, taskStates: taskStates(local) };
}

function taskStates(db) {
  const tables = tableNames(db).filter((table) => /(?:jobs|processing_runs|llm_tasks|llm_runs|llm_run_artifacts)$/.test(table));
  return Object.fromEntries(tables.flatMap((table) => columnsFor(db, table).some((column) => column.name === "status")
    ? [[table, db.prepare(`select status, count(*) as count from ${identifier(table)} group by status order by status`).all()]]
    : []));
}

function renderMarkdown(data, jsonPath) {
  const rows = Object.entries(data.scopes).map(([scope, value]) => `| ${scope} | ${summary(value.local)} | ${summary(value.miniflare)} | ${value.onlyInLocal ?? "n/a"} | ${value.onlyInMiniflare ?? "n/a"} |`).join("\n");
  return `# Local Node runtime baseline audit\n\nCollected: ${data.collectedAt}\n\nCommands: \`${data.commands.join("\` ; \`")}\`\n\n- Node SQLite: \`${data.localDb.file}\` (${data.localDb.bytes} bytes, ${Object.keys(data.localDb.tables).length} tables)\n- Canonical historical Miniflare D1: \`${data.canonicalMiniflare || "not found"}\`\n- Machine-readable detail: \`${jsonPath}\`\n\n## Scoped database comparison\n\n| Scope | Node SQLite | Miniflare D1 | Node-only primary keys | Miniflare-only primary keys |\n| --- | --- | --- | ---: | ---: |\n${rows}\n\nThe JSON report retains each scoped schema and every table's row count and maximum date-like field. Tables without compatible declared primary keys are deliberately not inferred equal.\n\n## Runtime baseline\n\n### Listeners\n\n\`\`\`text\n${data.runtime.listeners.join("\n") || "none"}\n\`\`\`\n\n### Repository-related processes\n\n\`\`\`text\n${data.runtime.processes.join("\n") || "none"}\n\`\`\`\n\n### Task states\n\n\`\`\`json\n${JSON.stringify(data.runtime.taskStates, null, 2)}\n\`\`\`\n\n## Decision\n\n- Node SQLite: ${data.decision.local}.\n- Miniflare: ${data.decision.miniflare}.\n`;
}

function summary(value) {
  return value ? `${value.rowCount} rows; max ${Object.entries(value.maxTimestamp).map(([key, item]) => `${key}=${item}`).join(", ") || "n/a"}` : "absent";
}

function command(file, args) {
  try { return execFileSync(file, args, { encoding: "utf8" }); } catch { return ""; }
}

function identifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`unsafe SQLite identifier: ${value}`);
  return `"${value}"`;
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
