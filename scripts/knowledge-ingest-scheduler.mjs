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
  const cronExpression = String(automation.cron || "*/15 * * * *").trim();
  return {
    enabled: automation.enabled !== false,
    runOnStart: automation.runOnStart === true,
    cronExpression,
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
    onEvent("started", { reason });
    try {
      await runChild({
        command: "./process-knowledge.sh",
        args: [],
        cwd: root,
        env: process.env,
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
  onEvent("scheduled", { cron: config.cronExpression, timezone: "Asia/Shanghai", next: job.nextRun()?.toISOString() ?? null });
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
