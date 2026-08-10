import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GENERIC_LLM_HANDLER_KEYS, listGenericLlmHandlers, runGenericLlmHandler, selectGenericLlmHandler } from "./generic-llm-handler-registry.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function sendJson(response, data) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ code: 200, msg: "success", data }));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

test("generic dispatcher selects handlers by persisted handler key", () => {
  assert.equal(selectGenericLlmHandler("company_report_discovery")?.family, "company");
  assert.equal(selectGenericLlmHandler({ handlerKey: "research_web_search" })?.family, "research-web-search");
  assert.equal(selectGenericLlmHandler({ taskType: "information_processing" })?.family, "knowledge");
  assert.equal(selectGenericLlmHandler("does_not_exist"), null);
  assert.deepEqual(listGenericLlmHandlers().map((handler) => handler.key), [...GENERIC_LLM_HANDLER_KEYS]);
});

test("local runtime provider and legacy research cap are the generic model cap", async () => {
  const config = JSON.parse(await readFile(new URL("../../config/local-job-runtime.json", import.meta.url), "utf8"));
  assert.equal(config.provider.globalConcurrency, 5);
  assert.equal(config.handlers.researchOperatingAnalysis.concurrency, 5);
  assert.equal(config.genericDispatcher.handlerConcurrency.research_operating_analysis_low_dependency_stage, 1);
});

test("materialized low-dependency stage handlers receive runner config and provider client", async () => {
  const calls = { provider: [], stageStarts: 0, stageCompletes: 0, runCompletes: [] };
  const statement = (type) => ({
    source: "eastmoney",
    dataAsOf: "2026-03-31",
    latestReportDate: "2026-03-31",
    reportingCurrencies: ["CNY"],
    rows: [{
      reportDate: "2026-03-31",
      fiscalPeriod: "Q1",
      source: "eastmoney",
      payload: type === "income"
        ? { CURRENCY: "CNY", TOTAL_OPERATE_INCOME: 100, OPERATE_COST: 60, NETPROFIT: 10 }
        : type === "balance"
          ? { CURRENCY: "CNY", MONETARYFUNDS: 20, TOTAL_ASSETS: 100, TOTAL_LIABILITIES: 40, TOTAL_PARENT_EQUITY: 60 }
          : { CURRENCY: "CNY", NETCASH_OPERATE: 12, CONSTRUCT_LONG_ASSET: 3 },
    }],
    sourceHealth: { status: "healthy" },
    delivery: { originProviders: ["eastmoney"], updatedAt: Date.parse("2026-08-09T00:00:00Z"), freshness: "fresh" },
  });
  const state = {
    stages: [{
      stageKey: "local_routing_match",
      stepKey: "local_routing_match",
      artifactId: "llm-artifact:routing",
      status: "complete",
      output: {
        routingState: "confirmed",
        industryTemplateId: "optical-transceiver-ai-interconnect.v1",
        industryKey: "optical-transceiver-ai-interconnect",
        companyScope: { products: ["光模块"], customers: ["云厂商"] },
        sourceIds: [],
        evidenceIds: [],
      },
    }],
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === "/responses") {
      const body = JSON.parse(await readBody(request));
      calls.provider.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "# 公司事实\\n\\n测试输出" })}`,
        `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "# 公司事实\\n\\n测试输出" }] }] } })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    if (request.method === "GET" && pathname === "/api/company/overview") {
      sendJson(response, { name: "测试公司", source: "xueqiu", marketDate: "2026-08-09", latestPrice: 10, scopeEnvelope: { primaryBusiness: "光模块", products: ["光模块"], customers: ["云厂商"], industry: "光通信" } });
      return;
    }
    if (request.method === "GET" && pathname === "/api/finance/income") { sendJson(response, statement("income")); return; }
    if (request.method === "GET" && pathname === "/api/finance/balance") { sendJson(response, statement("balance")); return; }
    if (request.method === "GET" && pathname === "/api/finance/cashflow") { sendJson(response, statement("cashflow")); return; }
    if (request.method === "GET" && pathname === "/api/research/company/300308.SZ/operating-analysis-low-dependency") { sendJson(response, state); return; }
    if (request.method === "POST" && /\/stages\/financial_quality\/(start|complete)$/.test(pathname)) {
      const body = JSON.parse(await readBody(request));
      if (pathname.endsWith("/start")) {
        calls.stageStarts += 1;
        sendJson(response, { stageKey: "financial_quality", status: "running", runId: body.runId, taskId: body.taskId });
      } else {
        calls.stageCompletes += 1;
        sendJson(response, { stageKey: "financial_quality", stepKey: "financial_quality", artifactId: "llm-artifact:financial-quality", status: body.status, output: body.output, ...(body.lineage || {}) });
      }
      return;
    }
    if (request.method === "POST" && pathname.endsWith("/heartbeat")) { await readBody(request); sendJson(response, { active: true }); return; }
    if (request.method === "POST" && /\/api\/llm-tasks\/llm-run:test\/(complete|fail)$/.test(pathname)) {
      const body = JSON.parse(await readBody(request));
      calls.runCompletes.push({ path: pathname, body });
      sendJson(response, { status: pathname.endsWith("/complete") ? "completed" : "failed" });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: 404, msg: `unhandled ${request.method} ${pathname}` }));
  });
  const port = await listen(server);
  const previous = {
    runnerBaseUrl: process.env.OPERATING_ANALYSIS_LOW_DEPENDENCY_RUNNER_BASE_URL,
    openAiBaseUrl: process.env.OPENAI_BASE_URL,
    openAiApiKey: process.env.OPENAI_API_KEY,
  };
  process.env.OPERATING_ANALYSIS_LOW_DEPENDENCY_RUNNER_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OPENAI_API_KEY = "generic-registry-test-key";
  try {
    const handler = selectGenericLlmHandler("research_operating_analysis_low_dependency_stage");
    await runGenericLlmHandler(handler, {
      handlerKey: handler.key,
      stageKey: "financial_quality",
      securityCode: "300308.SZ",
      taskId: "llm-task:test",
      runId: "llm-run:test",
      attempt: 1,
      model: "test-model",
      reasoningEffort: "low",
    }, "generic-dispatcher:test");
  } finally {
    if (previous.runnerBaseUrl === undefined) delete process.env.OPERATING_ANALYSIS_LOW_DEPENDENCY_RUNNER_BASE_URL; else process.env.OPERATING_ANALYSIS_LOW_DEPENDENCY_RUNNER_BASE_URL = previous.runnerBaseUrl;
    if (previous.openAiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = previous.openAiBaseUrl;
    if (previous.openAiApiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.openAiApiKey;
    await close(server);
  }
  assert.equal(calls.provider.length, 1, "stage child reached the provider instead of failing before AbortSignal.timeout");
  assert.equal(calls.provider[0].model, "test-model");
  assert.equal(calls.stageStarts, 1);
  assert.equal(calls.stageCompletes, 1);
  assert.equal(calls.runCompletes.length, 1);
  assert.equal(calls.runCompletes[0].path, "/api/llm-tasks/llm-run:test/complete");
});
