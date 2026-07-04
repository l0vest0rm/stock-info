#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const dbFile = resolve(args.dbFile || findLocalDatabaseFile());
const contentDir = resolve(args.contentDir || process.env.KNOWLEDGE_CONTENT_LOCAL_DIR || "/Users/terry/git/data/stock-info/knowledge/content-cache");

const contentRows = queryJson(dbFile, `
  select content_key, content_bytes
  from knowledge_local_content_cache
  where content_key like 'knowledge-content/%'
  order by content_key asc
`);
const chunkRows = queryJson(dbFile, `
  select content_key, payload_base64
  from knowledge_local_content_cache_chunks
  order by content_key asc, chunk_index asc
`);

const payloadByKey = new Map();
for (const row of chunkRows) {
  const key = String(row.content_key || "").trim();
  const payload = String(row.payload_base64 || "");
  if (!key || !payload) continue;
  payloadByKey.set(key, `${payloadByKey.get(key) || ""}${payload}`);
}

let written = 0;
let skipped = 0;
for (const row of contentRows) {
  const key = String(row.content_key || "").trim();
  const payloadBase64 = payloadByKey.get(key) || "";
  if (!key || !payloadBase64) {
    continue;
  }
  const bytes = Buffer.from(payloadBase64, "base64");
  const relativePath = contentRelativePath(key);
  const outputPath = join(contentDir, relativePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  if (isSameSizedFile(outputPath, bytes.length)) {
    skipped += 1;
    continue;
  }
  writeFileSync(outputPath, bytes);
  written += 1;
}

console.log(JSON.stringify({
  dbFile,
  contentDir,
  total: contentRows.length,
  materialized: written,
  skipped,
}, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db-file") {
      parsed.dbFile = requireValue(argv, ++index, arg);
    } else if (arg === "--content-dir") {
      parsed.contentDir = requireValue(argv, ++index, arg);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`missing value for ${flag}`);
  return value;
}

function findLocalDatabaseFile() {
  const candidates = execFileSync("find", [".wrangler/state/v3/d1/miniflare-D1DatabaseObject", "-name", "*.sqlite"], {
    encoding: "utf8",
    stdio: "pipe",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !file.endsWith("/metadata.sqlite"));
  for (const file of candidates) {
    const tables = execFileSync("sqlite3", [file, ".tables"], { encoding: "utf8", stdio: "pipe" });
    if (tables.includes("knowledge_local_content_cache") && tables.includes("knowledge_docs")) {
      return file;
    }
  }
  throw new Error("failed to locate local stock_info D1 sqlite database");
}

function queryJson(dbFile, sql) {
  const result = execFileSync("sqlite3", ["-json", dbFile, sql], {
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 50 * 1024 * 1024,
  }).trim();
  return result ? JSON.parse(result) : [];
}

function contentRelativePath(key) {
  const normalized = String(key || "").trim().replace(/^\/+|\/+$/g, "");
  if (!normalized.startsWith("knowledge-content/")) {
    throw new Error(`unsupported content key: ${key}`);
  }
  const relativePath = normalized.slice("knowledge-content/".length);
  if (!relativePath || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe content key: ${key}`);
  }
  return relativePath;
}

function isSameSizedFile(file, size) {
  try {
    return statSync(file).size === size;
  } catch {
    return false;
  }
}
