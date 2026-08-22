#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { loadKnowledgeDefaults } from "./knowledge-defaults.mjs";
import { executeLocalD1Sql, queryLocalD1Sql, resolveLocalD1Database } from "./lib/local-d1-sqlite.mjs";

const defaults = loadKnowledgeDefaults();
const args = parseArgs(process.argv.slice(2), defaults);
if (args.help) {
  printHelp();
  process.exit(0);
}
if (!args.remote) args.databasePath = resolveLocalD1Database({ requiredTable: "knowledge_docs" });
const run = {
  startedAt: Date.now(),
  source: "knowledge_docs_cleanup",
};

try {
  const summary = cleanupKnowledgeDocs(args);
  if (args.writeRun) {
    writeMaintenanceState({
      database: args.database,
      remote: args.remote,
      source: run.source,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      status: "success",
      stats: summary,
    });
  }
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (args.writeRun) {
    try {
      writeMaintenanceState({
        database: args.database,
        remote: args.remote,
        source: run.source,
        startedAt: run.startedAt,
        finishedAt: Date.now(),
        status: "failed",
        stats: {},
        error: message,
      });
    } catch {
      // Ignore secondary write failures.
    }
  }
  throw error;
}

function cleanupKnowledgeDocs(options) {
  if (!options.enabled || options.maxAgeDays <= 0) {
    return {
      dryRun: !options.apply,
      database: options.remote ? options.database : options.databasePath,
      databasePath: options.databasePath || null,
      remote: options.remote,
      retentionEnabled: options.enabled,
      maxAgeDays: options.maxAgeDays,
      skipped: true,
      reason: "knowledge docs retention disabled",
    };
  }

  const cutoffIso = new Date(Date.now() - options.maxAgeDays * 86400000).toISOString();
  const expiredDocs = querySingleInteger(`
    select count(*) as count
    from knowledge_docs
    where coalesce(event_time, published_at, fetched_at, '') != ''
      and datetime(coalesce(event_time, published_at, fetched_at)) < datetime(${sqlString(cutoffIso)})
  `, options);
  const expiredRefs = querySingleInteger(`
    select count(*) as count
    from knowledge_doc_content_refs
    where doc_id in (
      select doc_id
      from knowledge_docs
      where coalesce(event_time, published_at, fetched_at, '') != ''
        and datetime(coalesce(event_time, published_at, fetched_at)) < datetime(${sqlString(cutoffIso)})
    )
  `, options);

  if (options.apply && expiredDocs > 0) {
    executeSql(`
      delete from knowledge_docs
      where coalesce(event_time, published_at, fetched_at, '') != ''
        and datetime(coalesce(event_time, published_at, fetched_at)) < datetime(${sqlString(cutoffIso)});
    `, options);
  }

  return {
    dryRun: !options.apply,
    database: options.remote ? options.database : options.databasePath,
    databasePath: options.databasePath || null,
    remote: options.remote,
    retentionEnabled: options.enabled,
    maxAgeDays: options.maxAgeDays,
    cutoffIso,
    expiredDocs,
    expiredContentRefs: expiredRefs,
    deletedDocs: options.apply ? expiredDocs : 0,
  };
}

function parseArgs(argv, defaults) {
  const parsed = {
    database: defaults.database,
    remote: false,
    apply: false,
    enabled: defaults.r2ExpireDays > 0,
    maxAgeDays: defaults.r2ExpireDays,
    writeRun: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--remote") parsed.remote = true;
    else if (arg === "--local") parsed.remote = false;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--apply") parsed.apply = true;
    else if (arg === "--dry-run") parsed.apply = false;
    else if (arg === "--database") parsed.database = requireValue(argv, ++i, arg);
    else if (arg === "--max-age-days") parsed.maxAgeDays = positiveInteger(requireValue(argv, ++i, arg), parsed.maxAgeDays);
    else if (arg === "--disable-retention") parsed.enabled = false;
    else if (arg === "--skip-run-record") parsed.writeRun = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function querySingleInteger(sql, options) {
  if (!options.remote) {
    return integer(queryLocalD1Sql(sql, { requiredTable: "knowledge_docs" })[0]?.count, 0);
  }
  const output = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", options.database, "--remote", "--json", "--command", sql],
    { encoding: "utf8", stdio: "pipe", maxBuffer: 20 * 1024 * 1024 }
  );
  const payload = JSON.parse(output);
  return integer(payload[0]?.results?.[0]?.count, 0);
}

function executeSql(sql, options) {
  if (!options.remote) {
    executeLocalD1Sql(sql, { requiredTable: "knowledge_docs" });
    return;
  }
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", options.database, "--remote", "--command", sql],
    { encoding: "utf8", stdio: "pipe", maxBuffer: 20 * 1024 * 1024 }
  );
}

function writeMaintenanceState({ database, remote, source, startedAt, finishedAt, status, stats, error = "" }) {
  const value = JSON.stringify({ status, source, startedAt, finishedAt, stats, error });
  const sql = `
    insert into kv_cache (namespace, key, value_json, expires_at, updated_at)
    values ('knowledge_maintenance', ${sqlString(source)}, ${sqlString(value)}, null, ${finishedAt})
    on conflict(namespace, key) do update set
      value_json=excluded.value_json,
      expires_at=excluded.expires_at,
      updated_at=excluded.updated_at;
  `;
  executeSql(sql, { database, remote });
}

function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function printHelp() {
  console.log(`Usage: node scripts/cleanup-knowledge-docs.mjs [--local|--remote] [--dry-run|--apply]

Local mode reads and writes Node SQLite at LOCAL_DB_PATH (default data/local/stock-info.sqlite). Remote mode explicitly uses Cloudflare D1.`);
}
