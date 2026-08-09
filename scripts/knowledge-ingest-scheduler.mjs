#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Cron } from "croner";

const root = resolve(new URL("..", import.meta.url).pathname);

export function loadKnowledgeIngestConfig(configPath = resolve(root, "config/knowledge-processing.json")) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const automation = config.automation && typeof config.automation === "object" ? config.automation : {};
  const informationProcessing = config.informationProcessing && typeof config.informationProcessing === "object" ? config.informationProcessing : {};
  const cronExpression = String(automation.cron || "*/15 * * * *").trim();
  const configuredMaxDocuments = Number(informationProcessing.maxDocumentsPerRun);
  return {
    enabled: automation.enabled !== false,
    runOnStart: automation.runOnStart === true,
    cronExpression,
    maxDocumentsPerRun: Number.isFinite(configuredMaxDocuments) ? Math.max(0, Math.min(200, Math.floor(configuredMaxDocuments))) : 5,
  };
}

/**
 * Schedules ingestion without becoming its own daemon. `runChild` is supplied
 * by local-supervisor, which retains the exact child handle until exit.
 */
export function startKnowledgeIngestScheduler({
  configPath = resolve(root, "config/knowledge-processing.json"),
  runChild = defaultRunChild,
  onEvent = defaultEvent,
} = {}) {
  const config = loadKnowledgeIngestConfig(configPath);
  if (!config.enabled) {
    onEvent("disabled", {});
    return { stop() {}, runNow: async () => false, config };
  }
  let active = false;
  let stopping = false;
  const runNow = async (reason) => {
    if (stopping) return false;
    if (active) {
      onEvent("skipped_overlap", { reason });
      return false;
    }
    active = true;
    const startedAt = Date.now();
    onEvent("started", { reason, max_documents_per_run: config.maxDocumentsPerRun });
    try {
      await runChild({
        command: "./process-knowledge.sh",
        args: [],
        cwd: root,
        env: { ...process.env, INFORMATION_PROCESSING_MAX_DOCUMENTS: String(config.maxDocumentsPerRun) },
      });
      onEvent("completed", { reason, duration_ms: Date.now() - startedAt });
      return true;
    } catch (error) {
      onEvent("failed", { reason, duration_ms: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      active = false;
    }
  };
  const job = new Cron(config.cronExpression, {
    timezone: "Asia/Shanghai",
    catch: (error) => onEvent("cron_failed", { error: error instanceof Error ? error.message : String(error) }),
  }, () => { void runNow("schedule"); });
  onEvent("scheduled", { cron: config.cronExpression, timezone: "Asia/Shanghai", next: job.nextRun()?.toISOString() ?? null, max_documents_per_run: config.maxDocumentsPerRun });
  if (config.runOnStart) void runNow("startup");
  return {
    config,
    runNow,
    stop() { stopping = true; job.stop(); },
  };
}

function defaultRunChild({ command, args, cwd, env }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited code=${code ?? "null"} signal=${signal ?? "none"}`)));
  });
}

function defaultEvent(event, details) {
  console.log(`[knowledge-ingest] ${event} ${JSON.stringify(details)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scheduler = startKnowledgeIngestScheduler({ configPath: resolve(root, process.argv[2] || "config/knowledge-processing.json") });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { scheduler.stop(); process.exit(0); });
}
