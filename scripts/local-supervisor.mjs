#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readlink, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { startKnowledgeIngestScheduler } from "./knowledge-ingest-scheduler.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);
const runId = `local-${randomUUID()}`;
const host = process.env.HOST || "127.0.0.1";
const httpPort = positivePort(process.env.PORT || "8000", "PORT");
const contentPort = positivePort(process.env.KNOWLEDGE_CONTENT_LOCAL_PORT || "8788", "KNOWLEDGE_CONTENT_LOCAL_PORT");
const healthIntervalMs = positiveInteger(process.env.LOCAL_SUPERVISOR_HEALTH_INTERVAL_MS, 5_000, "LOCAL_SUPERVISOR_HEALTH_INTERVAL_MS");
const restartLimit = nonNegativeInteger(process.env.LOCAL_SUPERVISOR_MAX_RESTARTS, 3, "LOCAL_SUPERVISOR_MAX_RESTARTS");
const restartBackoffMs = positiveInteger(process.env.LOCAL_SUPERVISOR_RESTART_BACKOFF_MS, 1_000, "LOCAL_SUPERVISOR_RESTART_BACKOFF_MS");
const gracefulTimeoutMs = positiveInteger(process.env.LOCAL_SUPERVISOR_GRACEFUL_TIMEOUT_MS, 30_000, "LOCAL_SUPERVISOR_GRACEFUL_TIMEOUT_MS");
const previousStopTimeoutMs = positiveInteger(process.env.LOCAL_SUPERVISOR_PREVIOUS_STOP_TIMEOUT_MS, gracefulTimeoutMs + 5_000, "LOCAL_SUPERVISOR_PREVIOUS_STOP_TIMEOUT_MS");
const stateFile = resolve(process.env.LOCAL_XUEQIU_REFRESH_STATE_FILE || "data/local/runtime/xueqiu-cookie-refresh.json");
const cookieRefreshIntervalMs = positiveInteger(process.env.XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS, 21_600, "XUEQIU_COOKIE_REFRESH_INTERVAL_SECONDS") * 1_000;
const cookieRefreshRetryMs = positiveInteger(process.env.XUEQIU_COOKIE_REFRESH_RETRY_SECONDS, 300, "XUEQIU_COOKIE_REFRESH_RETRY_SECONDS") * 1_000;

let stopping = false;
let healthTimer = null;
let cookieTimer = null;
const children = new Map();
const oneShots = new Map();

function log(role, event, details = {}) {
  process.stdout.write(`${JSON.stringify({
    time: new Date().toISOString(),
    role,
    pid: process.pid,
    run_id: runId,
    job_id: null,
    attempt: null,
    duration_ms: null,
    error: null,
    ...details,
    event,
  })}\n`);
}

function failure(role, event, error, details = {}) {
  log(role, event, { ...details, error: error instanceof Error ? error.message : String(error) });
}

async function main() {
  await stopPreviousLocalSupervisors();
  await assertPortsAvailable([httpPort, contentPort]);
  const { startLocalCronScheduler } = await import(pathToFileURL(resolve(root, "data/local/runtime/cron.cjs")).href);
  const http = startCore("local-http", process.execPath, [resolve(root, "data/local/runtime/server.mjs")]);
  await waitForHealthy(`http://${host}:${httpPort}/api/health`, "local-http");
  await waitForHealthy(`http://${host}:${contentPort}/__health`, "local-http-content");
  const cron = await startLocalCronScheduler({
    configPath: resolve(process.env.LOCAL_CRON_CONFIG || "wrangler.jsonc"),
    onEvent: (event, details) => log("local-scheduler", `cron_${event}`, details),
  });
  const ingest = process.env.KNOWLEDGE_INGEST_SCHEDULER === "0"
    ? { stop() {} }
    : startKnowledgeIngestScheduler({
      configPath: resolve(process.env.LOCAL_KNOWLEDGE_INGEST_CONFIG || "config/knowledge-processing.json"),
      runChild: runOneShot,
      onEvent: (event, details) => log("local-scheduler", `knowledge_ingest_${event}`, details),
    });
  if (process.env.KNOWLEDGE_INGEST_SCHEDULER === "0") log("local-scheduler", "knowledge_ingest_disabled", { reason: "environment" });
  installShutdown({ cron, ingest });
  scheduleHealthChecks();
  scheduleCookieRefresh();
  log("local-supervisor", "ready", {
    http_url: `http://${host}:${httpPort}`,
    content_url: `http://${host}:${contentPort}`,
    roles: ["local-http", "local-scheduler"],
  });
}

function startCore(role, command, args) {
  const state = { role, command, args, child: null, restarts: 0, ready: false, exited: false };
  children.set(role, state);
  const start = () => {
    if (stopping) return;
    const child = spawn(command, args, {
      cwd: root,
      env: childEnvironment(role),
      stdio: ["ignore", "pipe", "pipe"],
    });
    state.child = child;
    state.ready = false;
    state.exited = false;
    state.restarting = false;
    attachChildOutput(role, child);
    log(role, "started", { child_pid: child.pid, restart: state.restarts });
    child.once("error", (error) => failure(role, "spawn_failed", error));
    child.once("exit", (code, signal) => {
      state.exited = true;
      state.ready = false;
      log(role, "exited", { child_pid: child.pid, exit_code: code, signal });
      if (stopping) return;
      if (state.restarts >= restartLimit) {
        failure("local-supervisor", "core_role_permanently_failed", new Error(`${role} exceeded ${restartLimit} restart attempts`), { role });
        void shutdown(1);
        return;
      }
      state.restarts += 1;
      const delay = Math.min(restartBackoffMs * 2 ** (state.restarts - 1), 30_000);
      log("local-supervisor", "restart_scheduled", { role, attempt: state.restarts, delay_ms: delay });
      setTimeout(start, delay).unref();
    });
  };
  state.start = start;
  start();
  return state;
}

function childEnvironment() { return { ...process.env, LOCAL_SUPERVISOR_RUN_ID: runId }; }

function attachChildOutput(role, child) {
  for (const [stream, level] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event = null;
        try { event = JSON.parse(line); } catch { /* preserve unstructured legacy output visibly */ }
        if (event?.event === "ready") stateReady(role);
        if (event && typeof event === "object" && typeof event.event === "string") {
          const { time: _time, role: _role, pid: _pid, run_id: _runId, event: childEvent, ...details } = event;
          log(role, childEvent, { ...details, stream: level, child_pid: child.pid });
        } else {
          log(role, "child_output", { stream: level, child_pid: child.pid, message: line.slice(0, 8_000) });
        }
      }
    });
  }
}

function stateReady(role) {
  const state = children.get(role);
  if (state && !state.ready) {
    state.ready = true;
    log(role, "ready", { child_pid: state.child?.pid ?? null });
  }
}

async function waitForReady(state, role) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (state.exited) throw new Error(`${role} exited before ready`);
    if (state.ready) return;
    await sleep(100);
  }
  throw new Error(`${role} did not report readiness within 15000ms`);
}

async function waitForHealthy(url, role) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        log(role, "ready", { health_url: url });
        return;
      }
    } catch { /* wait for the exact spawned child */ }
    const state = children.get("local-http");
    if (state?.exited) throw new Error(`${role} exited before readiness check passed`);
    await sleep(250);
  }
  throw new Error(`${role} did not become healthy: ${url}`);
}

function scheduleHealthChecks() {
  healthTimer = setInterval(() => {
    void checkHealth("local-http", `http://${host}:${httpPort}/api/health`);
    void checkHealth("local-http-content", `http://${host}:${contentPort}/__health`);
  }, healthIntervalMs);
}

async function checkHealth(role, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(3_000, healthIntervalMs - 1)) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    failure("local-supervisor", "liveness_failed", error, { role, health_url: url });
    requestCoreRestart("local-http");
  }
}

function requestCoreRestart(role) {
  const state = children.get(role);
  if (!state?.child || state.exited || state.restarting) return;
  state.restarting = true;
  log("local-supervisor", "restart_requested", { role, child_pid: state.child.pid });
  state.child.kill("SIGTERM");
}

function runOneShot({ command, args, cwd, env }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env: { ...env, LOCAL_SUPERVISOR_RUN_ID: runId }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    oneShots.set(child.pid, child);
    attachChildOutput("local-scheduler", child);
    log("local-scheduler", "one_shot_started", { command, child_pid: child.pid });
    child.once("error", (error) => { oneShots.delete(child.pid); rejectRun(error); });
    child.once("exit", (code, signal) => {
      oneShots.delete(child.pid);
      log("local-scheduler", "one_shot_exited", { command, child_pid: child.pid, exit_code: code, signal });
      code === 0 ? resolveRun() : rejectRun(new Error(`${command} exited code=${code ?? "null"} signal=${signal ?? "none"}`));
    });
  });
}

function scheduleCookieRefresh() {
  void (async () => {
    const dueIn = await cookieRefreshDueIn();
    cookieTimer = setTimeout(async () => {
      const succeeded = await refreshCookie();
      if (!stopping) scheduleCookieRefreshAfter(succeeded ? cookieRefreshIntervalMs : cookieRefreshRetryMs);
    }, dueIn);
    cookieTimer.unref();
    log("local-scheduler", "cookie_refresh_scheduled", { due_in_ms: dueIn });
  })();
}

function scheduleCookieRefreshAfter(delay) {
  cookieTimer = setTimeout(async () => {
    const succeeded = await refreshCookie();
    if (!stopping) scheduleCookieRefreshAfter(succeeded ? cookieRefreshIntervalMs : cookieRefreshRetryMs);
  }, delay);
  cookieTimer.unref();
}

async function cookieRefreshDueIn() {
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    const updatedAt = Number(state?.updated_at);
    if (Number.isFinite(updatedAt) && updatedAt > 0) return Math.max(0, cookieRefreshIntervalMs - (Date.now() - updatedAt));
  } catch { /* an absent state means refresh now */ }
  return 0;
}

async function refreshCookie() {
  const startedAt = Date.now();
  log("local-scheduler", "cookie_refresh_started", {});
  try {
    await runOneShot({
      command: process.execPath,
      args: [resolve(root, "scripts/refresh-xueqiu-cookie.mjs"), "--write-local-credential-store", "--json"],
      cwd: root,
      env: process.env,
    });
    await mkdir(dirname(stateFile), { recursive: true });
    const temporary = `${stateFile}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify({ updated_at: Date.now() })}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, stateFile);
    log("local-scheduler", "cookie_refresh_completed", { duration_ms: Date.now() - startedAt, http_restarted: false });
    return true;
  } catch (error) {
    failure("local-scheduler", "cookie_refresh_failed", error, { duration_ms: Date.now() - startedAt });
    return false;
  }
}

function installShutdown({ cron, ingest }) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => { void shutdown(0, { cron, ingest, signal }); });
}

async function shutdown(exitCode, scheduler = null) {
  if (stopping) return;
  stopping = true;
  if (healthTimer) clearInterval(healthTimer);
  if (cookieTimer) clearTimeout(cookieTimer);
  scheduler?.cron.stop();
  scheduler?.ingest.stop();
  log("local-supervisor", "stopping", { signal: scheduler?.signal ?? null });
  const active = [
    ...[...children.values()].map((state) => state.child),
    ...oneShots.values(),
  ].filter(Boolean);
  await Promise.all(active.map((child) => stopChild(child, oneShots.has(child.pid))));
  log("local-supervisor", "stopped", { exit_code: exitCode });
  process.exit(exitCode);
}

async function stopChild(child, processGroup = false) {
  if (child.exitCode !== null) return;
  if (processGroup) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  } else {
    child.kill("SIGTERM");
  }
  const exited = await Promise.race([onceExit(child), sleep(gracefulTimeoutMs).then(() => false)]);
  if (exited) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  await onceExit(child);
}

async function assertPortsAvailable(ports) {
  for (const port of ports) await new Promise((resolveListen, rejectListen) => {
    const server = createServer();
    server.once("error", (error) => rejectListen(new Error(`cannot start local supervisor: ${host}:${port} is unavailable (${error.code || error.message}); the existing listener was not modified`)));
    server.listen(port, host, () => server.close((error) => error ? rejectListen(error) : resolveListen()));
  });
}

async function stopPreviousLocalSupervisors() {
  const pids = await findOwnedSupervisorPids();
  if (pids.length === 0) return;
  for (const pid of pids) {
    log("local-supervisor", "previous_instance_stop_requested", { previous_pid: pid });
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  for (const pid of pids) {
    await waitForProcessExit(pid);
    log("local-supervisor", "previous_instance_stopped", { previous_pid: pid });
  }
}

async function findOwnedSupervisorPids() {
  const rows = await listProcesses();
  const pids = [];
  for (const row of rows) {
    if (row.pid === process.pid || !isSupervisorCommand(row.command)) continue;
    if (await processWorkingDirectory(row.pid) === root) pids.push(row.pid);
  }
  return [...new Set(pids)];
}

async function listProcesses() {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], { maxBuffer: 2 * 1024 * 1024 });
    return stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
    });
  } catch (error) {
    throw new Error(`cannot inspect local processes with ps: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isSupervisorCommand(command) {
  if (command.includes("--stop-previous")) return false;
  const tokens = command.trim().split(/\s+/);
  const scriptIndex = tokens.findIndex((token) => token === "scripts/local-supervisor.mjs" || token === resolve(root, "scripts/local-supervisor.mjs"));
  // Only the process that directly executes this script owns the local
  // supervisor role. A logging wrapper also carries this path as a child
  // argument and must never be mistaken for a previous supervisor.
  return scriptIndex === 1 && /(?:^|\/)node(?:js)?$/.test(tokens[0]);
}

async function processWorkingDirectory(pid) {
  if (process.platform === "linux") {
    try { return await readlink(`/proc/${pid}/cwd`); } catch { /* use lsof below */ }
  }
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { maxBuffer: 16 * 1024 });
    return stdout.split(/\r?\n/).find((line) => line.startsWith("n"))?.slice(1) || null;
  } catch (error) {
    throw new Error(`cannot inspect cwd for local process ${pid}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + previousStopTimeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await sleep(100);
  }
  throw new Error(`previous local supervisor pid ${pid} did not stop within ${previousStopTimeoutMs}ms`);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function onceExit(child) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => child.once("exit", () => resolveExit(true)));
}

function positivePort(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${name} must be a TCP port from 1 to 65535`);
  return parsed;
}

function positiveInteger(value, fallback, name) {
  const parsed = Number(value);
  if (value !== undefined && (!Number.isInteger(parsed) || parsed < 1)) throw new Error(`${name} must be a positive integer`);
  return value === undefined ? fallback : parsed;
}

function nonNegativeInteger(value, fallback, name) {
  const parsed = Number(value);
  if (value !== undefined && (!Number.isInteger(parsed) || parsed < 0)) throw new Error(`${name} must be a non-negative integer`);
  return value === undefined ? fallback : parsed;
}

function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }

if (process.argv.includes("--stop-previous")) {
  void stopPreviousLocalSupervisors().catch((error) => {
    failure("local-supervisor", "previous_instance_stop_failed", error);
    process.exitCode = 1;
  });
} else {
  void main().catch((error) => {
    failure("local-supervisor", "startup_failed", error);
    void shutdown(1);
  });
}
