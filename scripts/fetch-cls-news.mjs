#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fetchClsRollPage, mapClsTelegraphItem } from "./lib/cls-news.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const sharedDataRoot = "/Users/terry/git/data";
const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.config);
const cfg = config.clsNews || {};

if (cfg.enabled === false) {
  console.log(JSON.stringify({ source: "cls_news", skipped: true, reason: "disabled" }, null, 2));
  process.exit(0);
}

const outputDir = resolve(root, cfg.outputDir || `${sharedDataRoot}/news`);
const stateDir = resolve(root, config.stateDir || `${sharedDataRoot}/stock-info/knowledge/state`);
mkdirSync(outputDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });
const stateFile = resolve(stateDir, cfg.stateFile || "cls-news-fetch-state.json");
const state = loadJson(stateFile);
const now = new Date();
const nowSeconds = Math.floor(now.getTime() / 1000);
const lookbackSeconds = positiveInteger(cfg.lookbackDays, 2) * 24 * 60 * 60;
const overlapSeconds = nonNegativeInteger(cfg.overlapSeconds, 300);
const previousLatestCtime = args.fullRescan ? 0 : nonNegativeInteger(state.latestCtime, 0);
const cutoff = previousLatestCtime
  ? Math.max(nowSeconds - lookbackSeconds, previousLatestCtime - overlapSeconds)
  : nowSeconds - lookbackSeconds;
const pageSize = positiveInteger(cfg.pageSize, 50);
const maxPages = positiveInteger(cfg.maxPages, 50);
const seen = new Set();
const items = [];
let cursor = nowSeconds + 1;
let pagesFetched = 0;
let reachedCutoff = false;

for (let page = 1; page <= maxPages; page += 1) {
  const pageItems = await fetchClsRollPage({
    apiBaseUrl: cfg.apiBaseUrl,
    app: cfg.app,
    os: cfg.os,
    serviceVersion: cfg.serviceVersion,
    lastTime: cursor,
    pageSize,
    timeoutMs: positiveInteger(cfg.timeoutMs, 10_000),
  });
  pagesFetched += 1;
  if (pageItems.length === 0) {
    reachedCutoff = true;
    break;
  }
  let oldestCtime = cursor;
  for (const item of pageItems) {
    const id = String(item?.id ?? "").trim();
    const ctime = Number(item?.ctime);
    if (!id || !Number.isFinite(ctime)) {
      throw new Error(`CLS page ${page} contains an invalid item`);
    }
    oldestCtime = Math.min(oldestCtime, ctime);
    if (ctime >= cutoff && !seen.has(id)) {
      seen.add(id);
      items.push(item);
    }
  }
  if (oldestCtime <= cutoff || pageItems.length < pageSize) {
    reachedCutoff = true;
    break;
  }
  if (oldestCtime >= cursor) {
    throw new Error(`CLS pagination did not advance: cursor=${cursor} oldest=${oldestCtime}`);
  }
  cursor = oldestCtime;
}

if (!reachedCutoff) {
  throw new Error(`CLS news reached maxPages=${maxPages} before cutoff=${new Date(cutoff * 1000).toISOString()}`);
}

const fetchedAt = now.toISOString();
const docs = items
  .sort((left, right) => Number(left.ctime) - Number(right.ctime) || Number(left.id) - Number(right.id))
  .map((item) => mapClsTelegraphItem(item, fetchedAt));
const outputFile = join(outputDir, `cls-telegraph-${formatDate(now)}.jsonl`);
const existingDocs = loadJsonLines(outputFile);
const mergedDocs = docs.length > 0 ? mergeDocs(existingDocs, docs) : existingDocs;
if (docs.length > 0) {
  writeFileSync(outputFile, `${mergedDocs.map((doc) => JSON.stringify(doc)).join("\n")}\n`);
}
const latestCtime = Math.max(previousLatestCtime, ...items.map((item) => Number(item.ctime)), 0);
writeFileSync(stateFile, `${JSON.stringify({
  latestCtime,
  lastFetchedAt: fetchedAt,
  lastFetchedDocs: docs.length,
  lastFetchedPages: pagesFetched,
}, null, 2)}\n`);

console.log(JSON.stringify({
  source: "cls_news",
  output: outputFile,
  fetched: docs.length,
  written: mergedDocs.length,
  pagesFetched,
  cutoff: new Date(cutoff * 1000).toISOString(),
  latestCtime,
  stateFile,
}, null, 2));

function loadConfig(file) {
  const path = file ? resolve(root, file) : resolve(root, "config/knowledge-processing.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadJson(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`invalid CLS fetch state ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadJsonLines(file) {
  if (!existsSync(file)) return [];
  const body = readFileSync(file, "utf8").trim();
  if (!body) return [];
  try {
    return body.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    throw new Error(`invalid CLS output ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function mergeDocs(existing, incoming) {
  const byId = new Map();
  for (const doc of [...existing, ...incoming]) {
    const docId = String(doc?.docId ?? "").trim();
    if (!docId) throw new Error("CLS output contains a document without docId");
    byId.set(docId, doc);
  }
  return [...byId.values()].sort((left, right) =>
    String(left.publishedAt || "").localeCompare(String(right.publishedAt || ""))
      || String(left.docId).localeCompare(String(right.docId))
  );
}

function parseArgs(argv) {
  const parsed = { config: "", fullRescan: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") parsed.config = requireValue(argv, ++i, arg);
    else if (arg === "--inbox") i += 1;
    else if (arg === "--full-rescan") parsed.fullRescan = true;
    else if (arg === "--remote" || arg === "--local") continue;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`missing value for ${flag}`);
  return value;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
