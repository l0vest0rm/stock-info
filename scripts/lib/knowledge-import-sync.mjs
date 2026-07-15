import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const volatileRootKeys = new Set([
  "fetchedAt",
  "fetched_at",
  "file",
  "sourceFile",
  "source_file",
  "updatedAt",
  "updated_at",
]);

const volatileMetadataKeys = new Set([
  "inputFile",
  "inputRelativeFile",
  "originalFile",
  "processedAt",
  "sourceMtimeMs",
  "sourceSize",
]);

export function knowledgeImportFingerprint(raw) {
  const stable = stripVolatileImportFields(raw);
  const json = stableJson(stable);
  return `sha256:v1:${createHash("sha256").update(json).digest("hex")}`;
}

export function loadSyncLedger(file) {
  if (!file) {
    return { entries: [], bytes: 0, lines: 0 };
  }
  let body;
  try {
    body = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { entries: [], bytes: 0, lines: 0 };
    }
    throw error;
  }
  const entries = [];
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`invalid knowledge sync ledger JSON at ${file}:${index + 1}: ${error.message}`);
    }
  }
  return {
    entries,
    bytes: Buffer.byteLength(body),
    lines: entries.length,
  };
}

export function syncStateFor(entries, target) {
  const map = new Map();
  for (const entry of entries) {
    if (
      text(entry.scope) !== target.scope
      || text(entry.target) !== target.target
      || text(entry.database) !== target.database
    ) {
      continue;
    }
    const docId = text(entry.docId);
    if (docId) {
      map.set(docId, entry);
    }
  }
  return map;
}

export function appendSyncLedgerEntries(file, entries) {
  if (!file || entries.length === 0) return;
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "a" });
}

export function compactSyncLedger(file) {
  if (!file) {
    return { beforeLines: 0, afterLines: 0, beforeBytes: 0, afterBytes: 0 };
  }
  const loaded = loadSyncLedger(file);
  const latest = new Map();
  for (const entry of loaded.entries) {
    const key = syncEntryKey(entry);
    if (!key) {
      throw new Error(`knowledge sync ledger entry is missing scope/target/database/docId in ${file}`);
    }
    latest.set(key, entry);
  }
  const compacted = [...latest.values()];
  const body = compacted.length > 0
    ? `${compacted.map((entry) => JSON.stringify(entry)).join("\n")}\n`
    : "";
  const temp = join(dirname(file), `.${process.pid}-${Date.now()}-knowledge-sync.tmp`);
  try {
    writeFileSync(temp, body, { flag: "wx" });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
  return {
    beforeLines: loaded.lines,
    afterLines: compacted.length,
    beforeBytes: loaded.bytes,
    afterBytes: statSync(file).size,
  };
}

export function legacySourceFingerprintMatches(raw, entry, sourceFile = "") {
  const metadata = object(raw?.metadata ?? raw?.metadata_json);
  return text(entry.sourceFile) === text(sourceFile || metadata.inputRelativeFile)
    && integer(entry.sourceMtimeMs, -1) === integer(metadata.sourceMtimeMs, -2)
    && integer(entry.sourceSize, -1) === integer(metadata.sourceSize, -2);
}

function stripVolatileImportFields(value, path = []) {
  if (Array.isArray(value)) {
    return value.map((entry) => stripVolatileImportFields(entry, path));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const result = {};
  const isMetadata = path.at(-1) === "metadata" || path.at(-1) === "metadata_json";
  for (const key of Object.keys(value).sort()) {
    if (shouldIgnoreRootField(value, key)) continue;
    if (isMetadata && volatileMetadataKeys.has(key)) continue;
    result[key] = stripVolatileImportFields(value[key], [...path, key]);
  }
  return result;
}

function shouldIgnoreRootField(owner, key) {
  if (!volatileRootKeys.has(key)) return false;
  if (key !== "fetchedAt" && key !== "fetched_at") return true;
  return Boolean(
    text(owner.eventTime ?? owner.event_time)
    || text(owner.publishedAt ?? owner.published_at)
  );
}

function stableJson(value) {
  return JSON.stringify(value);
}

function syncEntryKey(entry) {
  const parts = [entry.scope, entry.target, entry.database, entry.docId].map(text);
  return parts.every(Boolean) ? parts.join("\u0000") : "";
}

function object(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function text(value) {
  return String(value ?? "").trim();
}
