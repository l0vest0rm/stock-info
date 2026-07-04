#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContentOptions, planKnowledgeContent, prepareKnowledgeContentAsync } from "./knowledge-content-r2.mjs";

const args = parseArgs(process.argv.slice(2));
const contentOptions = buildContentOptions(args);
const maxSqlBatchBytes = positiveInteger(process.env.KNOWLEDGE_IMPORT_MAX_SQL_BATCH_BYTES, 700000);

assertLocalWranglerStopped(args);

const docRows = queryTable("knowledge_docs", "knowledge_doc_content_refs", args.database, args.remote);
const filteredRows = queryFilteredTable(args.database, args.remote);
const rows = [...docRows, ...filteredRows];

if (rows.length === 0) {
  console.log(JSON.stringify({ updated: 0, scopeCounts: { knowledge_docs: 0, knowledge_filtered_docs: 0 } }, null, 2));
  process.exit(0);
}

const updates = await mapWithConcurrency(rows, contentOptions.uploadConcurrency, async (row) => {
  const filePath = row.contentKey.slice("localfs:".length);
  const markdown = readFileSync(filePath, "utf8");
  const contentRemote = args.remote || args.uploadContentRemote;
  const prepared = (args.dryRun || args.skipContentUpload)
    ? planKnowledgeContent({ docId: row.docId, markdown, remote: contentRemote, options: contentOptions })
    : await prepareKnowledgeContentAsync({
      docId: row.docId,
      markdown,
      remote: contentRemote,
      options: contentOptions,
    });
  if (!prepared.contentKey || prepared.contentKey.startsWith("localfs:")) {
    throw new Error(`failed to migrate ${row.scope}:${row.docId}; content key is still localfs`);
  }
  return {
    scope: row.scope,
    refTable: row.refTable,
    docId: row.docId,
    contentKey: prepared.contentKey,
    contentUrl: prepared.contentUrl,
    contentType: prepared.contentType,
    contentEncoding: prepared.contentEncoding,
    contentBytes: prepared.contentBytes,
    contentSha256: prepared.contentSha256,
    contentPreview: prepared.contentPreview,
  };
});

if (!args.dryRun) {
  for (const [scope, items] of Object.entries(groupByScope(updates))) {
    if (items.length === 0) continue;
    for (const sql of renderUpdateSqlBatches(scope, items, maxSqlBatchBytes)) {
      executeSqlFile(sql, args.database, args.remote);
    }
  }
}

console.log(JSON.stringify({
  dryRun: args.dryRun,
  updated: updates.length,
  scopeCounts: {
    knowledge_docs: updates.filter((item) => item.scope === "knowledge_docs").length,
    knowledge_filtered_docs: updates.filter((item) => item.scope === "knowledge_filtered_docs").length,
  },
  sample: updates.slice(0, 5),
}, null, 2));

function parseArgs(argv) {
  const parsed = {
    database: "stock_info",
    remote: false,
    uploadContentRemote: false,
    skipContentUpload: false,
    dryRun: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--remote") parsed.remote = true;
    else if (arg === "--local") parsed.remote = false;
    else if (arg === "--upload-content-remote") parsed.uploadContentRemote = true;
    else if (arg === "--skip-content-upload") parsed.skipContentUpload = true;
    else if (arg === "--apply") parsed.dryRun = false;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--database") parsed.database = requireValue(argv, ++i, arg);
    else if (arg === "--content-bucket") parsed.contentBucket = requireValue(argv, ++i, arg);
    else if (arg === "--content-public-base-url") parsed.contentPublicBaseUrl = requireValue(argv, ++i, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`missing value for ${flag}`);
  return value;
}

function queryTable(table, refTable, database, remote) {
  const sql = `select d.doc_id, c.content_key
    from ${table} d
    join ${refTable} c on c.doc_id = d.doc_id
    where c.content_key like 'localfs:%'
    order by d.doc_id`;
  const payload = executeSql(sql, database, remote);
  const results = payload[0]?.results || [];
  return results.map((row) => ({
    scope: table,
    refTable,
    docId: String(row.doc_id || ""),
    contentKey: String(row.content_key || ""),
  }));
}

function queryFilteredTable(database, remote) {
  try {
    return queryTable("knowledge_filtered_docs", "knowledge_filtered_doc_content_refs", database, remote);
  } catch (error) {
    const message = `${error?.message || ""}${error?.stderr || ""}${error?.stdout || ""}`;
    if (message.includes("no such table")) {
      return [];
    }
    throw error;
  }
}

function executeSql(sql, database, remote) {
  const result = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      database,
      remote ? "--remote" : "--local",
      "--command",
      sql,
      "--json",
    ],
    {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: "pipe",
    },
  );
  return JSON.parse(result);
}

function executeSqlFile(sql, database, remote) {
  const dir = mkdtempSync(join(tmpdir(), "stock-info-knowledge-migrate-"));
  const sqlFile = join(dir, "update.sql");
  try {
    writeFileSync(sqlFile, sql);
    execFileSync(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        database,
        remote ? "--remote" : "--local",
        "--file",
        sqlFile,
      ],
      {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        stdio: "pipe",
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function renderUpdateStatement(scope, item) {
  const refTable = item.refTable || (scope === "knowledge_docs" ? "knowledge_doc_content_refs" : "knowledge_filtered_doc_content_refs");
  return `update ${refTable} set
    content_key=${q(item.contentKey)},
    content_url=${q(item.contentUrl)},
    content_type=${q(item.contentType)},
    content_encoding=${q(item.contentEncoding)},
    content_bytes=${Number(item.contentBytes || 0)},
    content_sha256=${q(item.contentSha256)}
    where doc_id=${q(item.docId)};`;
}

function renderPreviewUpdateStatement(scope, item) {
  return `update ${scope} set
    content_preview=${q(item.contentPreview)}
    where doc_id=${q(item.docId)};`;
}

function renderUpdateSqlBatches(scope, items, maxBytes) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  for (const item of items) {
    const statements = [renderUpdateStatement(scope, item), renderPreviewUpdateStatement(scope, item)];
    const statement = statements.join("\n");
    const bytes = Buffer.byteLength(statement);
    if (current.length > 0 && currentBytes + bytes > maxBytes) {
      batches.push(current.join("\n"));
      current = [];
      currentBytes = 0;
    }
    current.push(...statements);
    currentBytes += bytes;
  }
  if (current.length > 0) {
    batches.push(current.join("\n"));
  }
  return batches;
}

function q(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function groupByScope(items) {
  return items.reduce((acc, item) => {
    if (!acc[item.scope]) acc[item.scope] = [];
    acc[item.scope].push(item);
    return acc;
  }, {});
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;
  const size = Math.max(1, Number(concurrency) || 1);
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  }));
  return results;
}

function assertLocalWranglerStopped(args) {
  if (args.remote || args.dryRun) {
    return;
  }
  const output = execFileSync("pgrep", ["-af", "wrangler dev"], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
  if (!output) {
    return;
  }
  const stockInfoWrangler = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => line.includes("/Users/terry/git/stock-info"));
  if (stockInfoWrangler) {
    throw new Error(
      `local knowledge migration requires stock-info wrangler dev to be stopped first: ${stockInfoWrangler}`,
    );
  }
}
