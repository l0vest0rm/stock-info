#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const args = parseArgs(process.argv.slice(2));
const dbTarget = args.remote ? "--remote" : "--local";
const existingTables = new Set(
  (runD1Sql(["select name from sqlite_master where type = 'table' and name like 'knowledge_%'"])[0] ?? [])
    .map((row) => String(row.name || "").trim())
    .filter(Boolean)
);

const dbInfo = args.remote ? runD1Info() : null;
const knowledgeTableStats = runD1Sql(knowledgeTableStatsSqls());
const knowledgeCategoryStats = runD1Sql([knowledgeCategoryStatsSql()]);
const filteredStatusStats = runD1Sql([filteredStatusStatsSql()]);
const r2Config = readR2Config(resolve(root, "wrangler.jsonc"));

const tableRows = knowledgeTableStats.flat();
const categoryRows = knowledgeCategoryStats[0] ?? [];
const filteredRows = filteredStatusStats[0] ?? [];

const knowledgeApproxBytes = tableRows.reduce((sum, row) => sum + integer(row.approxBytes, 0), 0);
const knowledgeDocCount = tableRows.find((row) => row.scope === "knowledge_docs")?.rowCount ?? 0;
const filteredDocCount = tableRows.find((row) => row.scope === "knowledge_filtered_docs")?.rowCount ?? 0;

const summary = {
  database: args.database,
  remote: args.remote,
  d1: {
    totalBytes: integer(dbInfo?.database_size, 0),
    usedBytes: integer(dbInfo?.database_size, 0),
    freeBytes: null,
    pageCount: null,
    pageSize: null,
    freelistCount: null,
    exactSizeAvailable: Boolean(dbInfo),
    knowledgeApproxBytes,
    knowledgeDocCount,
    filteredDocCount,
    tables: tableRows.map((row) => ({
      scope: row.scope,
      rowCount: integer(row.rowCount, 0),
      approxBytes: integer(row.approxBytes, 0),
      markdownBytes: integer(row.markdownBytes, 0),
      metadataBytes: integer(row.metadataBytes, 0),
      searchBytes: integer(row.searchBytes, 0),
    })),
    categories: categoryRows.map((row) => ({
      category: row.category,
      rowCount: integer(row.rowCount, 0),
      approxBytes: integer(row.approxBytes, 0),
      markdownBytes: integer(row.markdownBytes, 0),
      metadataBytes: integer(row.metadataBytes, 0),
      searchBytes: integer(row.searchBytes, 0),
    })),
    filteredStatuses: filteredRows.map((row) => ({
      status: row.status,
      rowCount: integer(row.rowCount, 0),
      approxBytes: integer(row.approxBytes, 0),
      markdownBytes: integer(row.markdownBytes, 0),
    })),
  },
  r2: r2Config,
};

if (!args.jsonOnly) {
  printHumanSummary(summary);
}

console.log(JSON.stringify(summary, null, 2));

function runD1Sql(commands) {
  const output = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      args.database,
      dbTarget,
      "--json",
      "--command",
      commands.join("; "),
    ],
    { cwd: root, stdio: "pipe", encoding: "utf8" }
  );
  return JSON.parse(output).map((entry) => entry.results ?? []);
}

function runD1Info() {
  const output = execFileSync(
    "npx",
    ["wrangler", "d1", "info", args.database, "--json"],
    { cwd: root, stdio: "pipe", encoding: "utf8" }
  );
  return JSON.parse(output);
}

function knowledgeTableStatsSqls() {
  const s = sqlSize;
  const parts = [];
  if (existingTables.has("knowledge_docs")) {
    parts.push(`
  select
    'knowledge_docs' as scope,
    count(*) as rowCount,
    sum(
      ${s("d.doc_id")} + ${s("d.source_type")} + ${s("d.report_type")} + ${s("d.source_name")} +
      ${s("d.title")} + ${s("d.url")} + ${s("d.published_at")} + ${s("d.fetched_at")} +
      ${s("d.event_time")} + ${s("d.target_name")} + ${s("d.target_code")} +
      ${s("d.discovery_method")} + ${s("d.access_method")} + ${s("d.summary")} +
      ${s("d.content_preview")} + ${s("d.metadata_json")} +
      ${s("d.recommendation_level")} + ${s("d.recommendation_tags_json")} +
      ${s("d.recommendation_reasons_json")} + 40
    ) as approxBytes,
    0 as markdownBytes,
    sum(${s("d.metadata_json")}) as metadataBytes,
    0 as searchBytes
  from knowledge_docs d`);
  }
  if (existingTables.has("knowledge_doc_content_refs")) {
    parts.push(`
  select
    'knowledge_doc_content_refs' as scope,
    count(*) as rowCount,
    sum(
      ${s("doc_id")} + ${s("content_key")} + ${s("content_url")} + ${s("content_type")} +
      ${s("content_encoding")} + ${s("content_sha256")} + 16
    ) as approxBytes,
    sum(coalesce(content_bytes, 0)) as markdownBytes,
    0 as metadataBytes,
    0 as searchBytes
  from knowledge_doc_content_refs`);
  }
  if (existingTables.has("knowledge_filtered_docs")) {
    parts.push(`
  select
    'knowledge_filtered_docs' as scope,
    count(*) as rowCount,
    sum(
      ${s("d.doc_id")} + ${s("d.source_type")} + ${s("d.report_type")} + ${s("d.source_name")} +
      ${s("d.title")} + ${s("d.url")} + ${s("d.published_at")} + ${s("d.fetched_at")} +
      ${s("d.event_time")} + ${s("d.target_name")} + ${s("d.target_code")} +
      ${s("d.summary")} + ${s("d.content_preview")} + ${s("d.metadata_json")} +
      ${s("d.filter_method")} + ${s("d.filter_reasons_json")} + ${s("d.source_file")} +
      ${s("d.reviewed_status")} + 24
    ) as approxBytes,
    0 as markdownBytes,
    sum(${s("d.metadata_json")}) as metadataBytes,
    0 as searchBytes
  from knowledge_filtered_docs d`);
  }
  if (existingTables.has("knowledge_filtered_doc_content_refs")) {
    parts.push(`
  select
    'knowledge_filtered_doc_content_refs' as scope,
    count(*) as rowCount,
    sum(
      ${s("doc_id")} + ${s("content_key")} + ${s("content_url")} + ${s("content_type")} +
      ${s("content_encoding")} + ${s("content_sha256")} + 16
    ) as approxBytes,
    sum(coalesce(content_bytes, 0)) as markdownBytes,
    0 as metadataBytes,
    0 as searchBytes
  from knowledge_filtered_doc_content_refs`);
  }
  if (existingTables.has("knowledge_doc_tags")) {
    parts.push(`
  select
    'knowledge_doc_tags' as scope,
    count(*) as rowCount,
    sum(${s("doc_id")} + ${s("tag")}) as approxBytes,
    0 as markdownBytes,
    0 as metadataBytes,
    0 as searchBytes
  from knowledge_doc_tags`);
  }
  if (existingTables.has("knowledge_stock_aliases")) {
    parts.push(`
  select
    'knowledge_stock_aliases' as scope,
    count(*) as rowCount,
    sum(${s("alias")} + ${s("code")} + ${s("name")} + ${s("source")} + 8) as approxBytes,
    0 as markdownBytes,
    0 as metadataBytes,
    0 as searchBytes
  from knowledge_stock_aliases`);
  }
  if (existingTables.has("knowledge_ingest_runs")) {
    parts.push(`
  select
    'knowledge_ingest_runs' as scope,
    count(*) as rowCount,
    sum(${s("run_id")} + ${s("status")} + ${s("source")} + ${s("stats_json")} + ${s("error")} + 16) as approxBytes,
    0 as markdownBytes,
    sum(${s("stats_json")}) as metadataBytes,
    0 as searchBytes
  from knowledge_ingest_runs`);
  }
  if (parts.length === 0) {
    return [`
select
  'knowledge_tables_missing' as scope,
  0 as rowCount,
  0 as approxBytes,
  0 as markdownBytes,
  0 as metadataBytes,
  0 as searchBytes
`];
  }
  return parts;
}

function knowledgeCategoryStatsSql() {
  const s = sqlSize;
  if (!existingTables.has("knowledge_docs")) {
    return `
select
  'unknown' as category,
  0 as rowCount,
  0 as approxBytes,
  0 as markdownBytes,
  0 as metadataBytes,
  0 as searchBytes
where 0
`;
  }
  return `
select
  case
    when d.source_type = 'research_report' and d.report_type = 'company_report' then 'company_report'
    when d.source_type = 'research_report' and d.report_type = 'industry_report' then 'industry_report'
    when d.source_type = 'research_report' then 'research_report_other'
    when d.source_type in ('local_news', 'web_news') then d.source_type
    when d.report_type in ('news', 'local_news', 'web_news') then d.report_type
    else coalesce(d.report_type, d.source_type, 'unknown')
  end as category,
  count(*) as rowCount,
  sum(
    ${s("d.doc_id")} + ${s("d.source_type")} + ${s("d.report_type")} + ${s("d.source_name")} +
    ${s("d.title")} + ${s("d.url")} + ${s("d.published_at")} + ${s("d.fetched_at")} +
    ${s("d.event_time")} + ${s("d.target_name")} + ${s("d.target_code")} +
    ${s("d.discovery_method")} + ${s("d.access_method")} + ${s("d.summary")} +
    ${s("d.content_preview")} + ${s("d.metadata_json")} +
    ${s("d.recommendation_level")} + ${s("d.recommendation_tags_json")} +
    ${s("d.recommendation_reasons_json")} + 40
  ) as approxBytes,
  0 as markdownBytes,
  sum(${s("d.metadata_json")}) as metadataBytes,
  0 as searchBytes
from knowledge_docs d
group by 1
order by approxBytes desc, rowCount desc, category asc
`;
}

function filteredStatusStatsSql() {
  const s = sqlSize;
  if (!existingTables.has("knowledge_filtered_docs")) {
    return `
select
  'pending' as status,
  0 as rowCount,
  0 as approxBytes,
  0 as markdownBytes
where 0
`;
  }
  return `
select
  coalesce(d.reviewed_status, 'pending') as status,
  count(*) as rowCount,
  sum(
    ${s("d.doc_id")} + ${s("d.source_type")} + ${s("d.report_type")} + ${s("d.source_name")} +
    ${s("d.title")} + ${s("d.url")} + ${s("d.published_at")} + ${s("d.fetched_at")} +
    ${s("d.event_time")} + ${s("d.target_name")} + ${s("d.target_code")} +
    ${s("d.summary")} + ${s("d.content_preview")} + ${s("d.metadata_json")} +
    ${s("d.filter_method")} + ${s("d.filter_reasons_json")} + ${s("d.source_file")} +
    ${s("d.reviewed_status")} + 24
  ) as approxBytes,
  0 as markdownBytes
from knowledge_filtered_docs d
group by 1
order by approxBytes desc, rowCount desc, status asc
`;
}

function sqlSize(column) {
  return `coalesce(length(cast(${column} as blob)), 0)`;
}

function parseArgs(argv) {
  const parsed = {
    database: "stock_info",
    remote: false,
    jsonOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--remote") parsed.remote = true;
    else if (arg === "--local") parsed.remote = false;
    else if (arg === "--database") parsed.database = requireValue(argv, ++i, arg);
    else if (arg === "--json-only") parsed.jsonOnly = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, Number(bytes) || 0);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function printHumanSummary(summary) {
  const label = summary.remote ? "remote" : "local";
  if (summary.d1.exactSizeAvailable) {
    console.log(`[knowledge-storage] D1 ${label}/${summary.database} total=${formatBytes(summary.d1.totalBytes)} exact=cloudflare`);
  } else {
    console.log(`[knowledge-storage] D1 ${label}/${summary.database} total=unavailable exact=not-supported-for-local estimate=${formatBytes(summary.d1.knowledgeApproxBytes)}`);
  }
  console.log(`[knowledge-storage] Knowledge payload approx=${formatBytes(summary.d1.knowledgeApproxBytes)} docs=${summary.d1.knowledgeDocCount} filtered=${summary.d1.filteredDocCount}`);
  for (const row of summary.d1.categories) {
    console.log(
      `[knowledge-storage] category=${row.category} rows=${row.rowCount} approx=${formatBytes(row.approxBytes)} markdown=${formatBytes(row.markdownBytes)} metadata=${formatBytes(row.metadataBytes)}`
    );
  }
  if (summary.d1.filteredStatuses.length > 0) {
    for (const row of summary.d1.filteredStatuses) {
      console.log(
        `[knowledge-storage] filtered status=${row.status} rows=${row.rowCount} approx=${formatBytes(row.approxBytes)} markdown=${formatBytes(row.markdownBytes)}`
      );
    }
  }
  if (summary.r2.configured) {
    console.log(`[knowledge-storage] R2 configured buckets=${summary.r2.buckets.join(", ")} size=unavailable via current local wrangler command set`);
  } else {
    console.log("[knowledge-storage] R2 not configured in wrangler.jsonc for this repo");
  }
  console.log("[knowledge-storage] Notes: category/table bytes are D1 payload approximations from row content, not exact index/SQLite overhead.");
}

function readR2Config(file) {
  try {
    const body = stripJsonComments(readFileSync(file, "utf8"));
    const parsed = JSON.parse(removeTrailingCommas(body));
    const buckets = Array.isArray(parsed.r2_buckets)
      ? parsed.r2_buckets
        .map((entry) => String(entry?.bucket_name || entry?.binding || "").trim())
        .filter(Boolean)
      : [];
    return {
      configured: buckets.length > 0,
      buckets,
    };
  } catch {
    return {
      configured: false,
      buckets: [],
    };
  }
}

function stripJsonComments(input) {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function removeTrailingCommas(input) {
  return input.replace(/,\s*([}\]])/g, "$1");
}
