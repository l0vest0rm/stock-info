#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadKnowledgeDefaults } from "./knowledge-defaults.mjs";

const defaults = loadKnowledgeDefaults();
const args = parseArgs(process.argv.slice(2), defaults);
const run = {
  runId: `knowledge-docs-cleanup:${randomUUID()}`,
  startedAt: Date.now(),
  source: "knowledge_docs_cleanup",
};

try {
  const summary = cleanupKnowledgeDocs(args);
  if (args.writeRun) {
    recordRun({
      database: args.database,
      remote: args.remote,
      runId: run.runId,
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
      recordRun({
        database: args.database,
        remote: args.remote,
        runId: run.runId,
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
      database: options.database,
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
    database: options.database,
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
  const output = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", options.database, options.remote ? "--remote" : "--local", "--json", "--command", sql],
    { encoding: "utf8", stdio: "pipe", maxBuffer: 20 * 1024 * 1024 }
  );
  const payload = JSON.parse(output);
  return integer(payload[0]?.results?.[0]?.count, 0);
}

function executeSql(sql, options) {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", options.database, options.remote ? "--remote" : "--local", "--command", sql],
    { encoding: "utf8", stdio: "pipe", maxBuffer: 20 * 1024 * 1024 }
  );
}

function recordRun({ database, remote, runId, source, startedAt, finishedAt, status, stats, error = "" }) {
  const sql = `
    insert into knowledge_ingest_runs (run_id, status, source, started_at, finished_at, stats_json, error)
    values (
      ${sqlString(runId)},
      ${sqlString(status)},
      ${sqlString(source)},
      ${startedAt},
      ${finishedAt},
      ${sqlString(JSON.stringify(stats))},
      ${sqlString(error)}
    );
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
