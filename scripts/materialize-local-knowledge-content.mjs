#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const args = parseArgs(process.argv.slice(2));
const dbFile = resolve(args.dbFile || findLocalDatabaseFile());
const contentDir = resolve(args.contentDir || process.env.KNOWLEDGE_CONTENT_LOCAL_DIR || "/Users/terry/git/data/stock-info/knowledge/content-cache");

const [contentCount] = queryJson(dbFile, `
  select count(*) as total
  from knowledge_local_content_cache
  where content_key like 'knowledge-content/%'
`);
const total = Number(contentCount?.total || 0);
const { written, skipped } = await materializeChunkRows(dbFile, contentDir);

console.log(JSON.stringify({
  dbFile,
  contentDir,
  total,
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

async function materializeChunkRows(dbFile, contentDir) {
  const sql = `
    select json_object(
      'content_key', chunks.content_key,
      'payload_base64', chunks.payload_base64
    )
    from knowledge_local_content_cache_chunks as chunks
    inner join knowledge_local_content_cache as content
      on content.content_key = chunks.content_key
    where content.content_key like 'knowledge-content/%'
    order by chunks.content_key asc, chunks.chunk_index asc
  `;
  const child = spawn("sqlite3", ["-batch", "-noheader", dbFile, sql], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveCompletion();
        return;
      }
      const detail = stderr.trim() || (signal ? `terminated by ${signal}` : `exit code ${code}`);
      rejectCompletion(new Error(`sqlite3 chunk query failed: ${detail}`));
    });
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let currentKey = "";
  let payloadChunks = [];
  let written = 0;
  let skipped = 0;

  const flush = () => {
    if (!currentKey || payloadChunks.length === 0) return;
    const bytes = Buffer.from(payloadChunks.join(""), "base64");
    const outputPath = join(contentDir, contentRelativePath(currentKey));
    mkdirSync(dirname(outputPath), { recursive: true });
    if (isSameSizedFile(outputPath, bytes.length)) {
      skipped += 1;
      return;
    }
    writeFileSync(outputPath, bytes);
    written += 1;
  };

  try {
    for await (const line of lines) {
      if (!line) continue;
      const row = JSON.parse(line);
      const key = String(row.content_key || "").trim();
      const payload = String(row.payload_base64 || "");
      if (!key || !payload) continue;
      if (currentKey && key !== currentKey) {
        flush();
        payloadChunks = [];
      }
      currentKey = key;
      payloadChunks.push(payload);
    }
    flush();
    await completion;
  } catch (error) {
    child.kill();
    await completion.catch(() => {});
    throw error;
  }

  return { written, skipped };
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
