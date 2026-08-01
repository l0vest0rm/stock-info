#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cron } from "croner";

const root = resolve(new URL("..", import.meta.url).pathname);
const configPath = resolve(root, process.argv[2] || "config/knowledge-processing.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const automation = config.automation && typeof config.automation === "object" ? config.automation : {};
const cronExpression = String(automation.cron || "*/15 * * * *").trim();
const runOnStart = automation.runOnStart === true;
let active = false;

if (automation.enabled === false) {
  console.log("[knowledge-ingest] disabled by config");
  process.exit(0);
}

async function runIngestion(reason) {
  if (active) {
    console.warn(`[knowledge-ingest] skipped overlapping run reason=${reason}`);
    return;
  }
  active = true;
  const startedAt = Date.now();
  console.log(`[knowledge-ingest] started reason=${reason}`);
  try {
    await new Promise((resolveRun, rejectRun) => {
      const child = spawn("./process-knowledge.sh", [], { cwd: root, stdio: "inherit" });
      child.once("error", rejectRun);
      child.once("exit", (code, signal) => code === 0 ? resolveRun() : rejectRun(new Error(`process-knowledge.sh exited code=${code ?? "null"} signal=${signal ?? "none"}`)));
    });
    console.log(`[knowledge-ingest] completed duration_ms=${Date.now() - startedAt}`);
  } catch (error) {
    console.error(`[knowledge-ingest] failed duration_ms=${Date.now() - startedAt}`, error);
  } finally {
    active = false;
  }
}

const job = new Cron(cronExpression, { timezone: "Asia/Shanghai", catch: (error) => console.error("[knowledge-ingest] cron failure", error) }, () => runIngestion("schedule"));
console.log(`[knowledge-ingest] scheduled cron=${JSON.stringify(cronExpression)} timezone=Asia/Shanghai next=${job.nextRun()?.toISOString() ?? "none"}`);
if (runOnStart) void runIngestion("startup");

process.once("SIGINT", () => { job.stop(); process.exit(0); });
process.once("SIGTERM", () => { job.stop(); process.exit(0); });
