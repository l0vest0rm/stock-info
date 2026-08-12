import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function send(response, data) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ code: 200, msg: "success", data }));
}

function sendGateway(response, data) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(data));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function terminalEvidence(markdown = "terminal") {
  return {
    schemaVersion: "webqa.completion-evidence.v1",
    outcome: "succeeded",
    provider: "chatgpt-web",
    providerUrl: "https://chatgpt.com/c/provider-session",
    resultKind: "text",
    signals: ["dom_stable", "sse_done"],
    contentSha256: `sha256:${markdown.length}`,
    contentChars: markdown.length,
    terminalAt: "2026-08-11T00:00:00Z",
  };
}

test("generic raw runner selects WebQA from lower task-type config without partial artifacts", async () => {
  const calls = [];
  const answer = { formatVersion: "webqa.answer.v1", content: { markdown: "terminal" }, citations: [], sources: [], rawSnapshot: { complete: true } };
  const gateway = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    calls.push({ kind: request.method, path: url.pathname, body: request.method === "POST" ? await body(request) : null });
    if (request.method === "POST" && url.pathname === "/api/webqa/tasks") {
      sendGateway(response, { task_id: "gateway-task:runner", status: "queued", provider: "chatgpt-web", answer: { ...answer, content: { markdown: "" } } });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/webqa/tasks/gateway-task%3Arunner") {
      sendGateway(response, {
        task_id: "gateway-task:runner",
        status: "succeeded",
        provider: "chatgpt-web",
        answer,
        terminal_evidence: terminalEvidence("terminal"),
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const gatewayPort = await listen(gateway);

  const runtime = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const item = { kind: request.method, path: url.pathname, body: request.method === "POST" ? await body(request) : null };
    calls.push(item);
    if (url.pathname.endsWith("/heartbeat") || url.pathname.endsWith("/progress")) { send(response, { active: true }); return; }
    if (url.pathname.endsWith("/artifact")) { send(response, { artifact: { status: "complete" } }); return; }
    if (url.pathname.endsWith("/complete")) { send(response, { status: "completed" }); return; }
    if (url.pathname.endsWith("/fail")) { send(response, { status: "failed" }); return; }
    response.writeHead(404);
    response.end();
  });
  const runtimePort = await listen(runtime);
  const directory = await mkdtemp(join(tmpdir(), "stock-info-webqa-runner-"));
  const configPath = join(directory, "execution.json");
  await writeFile(configPath, JSON.stringify({
    executionTransport: "openai",
    taskTypeTransports: { research_operating_analysis: "webqa" },
    webqa: {
      gatewayBaseUrl: `http://127.0.0.1:${gatewayPort}`,
      provider: "chatgpt-web",
      platform: "stock-info-test",
      pollIntervalMs: 1,
      taskTimeoutMs: 1000,
      cancelGraceMs: 1000,
      heartbeatIntervalMs: 10_000,
    },
  }));
  const previous = {
    config: process.env.GENERIC_LLM_EXECUTION_CONFIG,
    runtime: process.env.GENERIC_LLM_RAW_RUNNER_BASE_URL,
  };
  process.env.GENERIC_LLM_EXECUTION_CONFIG = configPath;
  process.env.GENERIC_LLM_RAW_RUNNER_BASE_URL = `http://127.0.0.1:${runtimePort}`;
  try {
    const module = await import(`./generic-llm-raw-runner.mjs?webqa-test=${gatewayPort}`);
    await module.runJob({
      taskId: "llm-task:runner",
      runId: "llm-run:runner",
      attempt: 1,
      taskType: "research_operating_analysis",
      handlerKey: "generic_raw_model",
      targetType: "security",
      targetId: "300308.SZ",
      idempotencyKey: "research-operating-analysis:300308.SZ",
      protocolVersion: "llm-task-protocol.v1",
      promptVersion: "investment-analysis.staged.v1",
      request: { rawModelRequest: { provider: "openai", model: "gpt-5.6-luna", input: [{ role: "user", content: [{ type: "input_text", text: "terminal" }] }] } },
    }, "runner:runner");
  } finally {
    if (previous.config === undefined) delete process.env.GENERIC_LLM_EXECUTION_CONFIG; else process.env.GENERIC_LLM_EXECUTION_CONFIG = previous.config;
    if (previous.runtime === undefined) delete process.env.GENERIC_LLM_RAW_RUNNER_BASE_URL; else process.env.GENERIC_LLM_RAW_RUNNER_BASE_URL = previous.runtime;
    await rm(directory, { recursive: true, force: true });
    await close(runtime);
    await close(gateway);
  }
  assert.equal(calls.filter((item) => item.path === "/api/webqa/tasks" && item.kind === "POST").length, 1);
  assert.equal(calls.some((item) => item.path.endsWith("/partial")), false);
  assert.equal(calls.filter((item) => item.path.endsWith("/artifact")).length, 1);
  assert.equal(calls.filter((item) => item.path.endsWith("/complete")).length, 1);
});
