import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const sharedDataRoot = "/Users/terry/git/data";

export function loadKnowledgeDefaults() {
  const config = loadConfig(resolve(root, "config/knowledge-processing.json"));
  const workDir = resolve(root, config.workDir || `${sharedDataRoot}/stock-info/knowledge/work`);
  const stateDir = resolve(root, config.stateDir || `${sharedDataRoot}/stock-info/knowledge/state`);
  return {
    root,
    config,
    database: text(config.database) || "stock_info",
    workDir,
    stateDir,
    importSyncFile: resolve(stateDir, text(config.importSyncFile) || "knowledge-remote-sync.jsonl"),
    processedDir: resolve(root, config.processedDir || `${sharedDataRoot}/stock-info/knowledge/processed`),
    contentBucket: text(process.env.KNOWLEDGE_CONTENT_BUCKET) || "stock-info-knowledge-content",
    r2LifecycleRuleId: "knowledge-content-expire",
    r2LifecyclePrefix: "knowledge-content/",
    r2ExpireDays: positiveInteger(process.env.KNOWLEDGE_CONTENT_EXPIRE_DAYS, positiveInteger(config.storageRetention?.knowledgeDocsMaxAgeDays, 90)),
  };
}

export function findLatestWorkFile(workDir, prefix) {
  const names = readdirSync(workDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"))
    .sort();
  if (names.length === 0) {
    throw new Error(`no ${prefix}*.jsonl files found in ${workDir}`);
  }
  const file = join(workDir, names[names.length - 1]);
  return {
    file,
    basename: basename(file),
    mtimeMs: statSync(file).mtimeMs,
  };
}

function loadConfig(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function text(value) {
  return String(value ?? "").trim();
}
