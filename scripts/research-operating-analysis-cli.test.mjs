import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, enqueueInvestmentAnalysis, parseArgs } from "./research-operating-analysis-cli.mjs";

test("CLI defaults match the page queue contract", () => {
  assert.deepEqual(parseArgs(["300308.sz"]), {
    code: "300308.SZ",
    model: DEFAULT_MODEL,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    baseUrl: "http://127.0.0.1:8000",
  });
});

test("CLI sends model and reasoning selection to the refresh endpoint and does not poll", async () => {
  let request;
  const result = await enqueueInvestmentAnalysis({
    code: "300308.SZ",
    model: "gpt-5.4-mini",
    reasoningEffort: "high",
    baseUrl: "http://127.0.0.1:8000/",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, status: 200, async json() { return { code: 200, msg: "OK", data: { shouldStart: true, job: { jobId: "job-1", status: "queued" } } }; } };
    },
  });
  assert.equal(request.url, "http://127.0.0.1:8000/api/research/company/300308.SZ/operating-analysis/refresh");
  assert.deepEqual(JSON.parse(request.init.body), { force: true, model: "gpt-5.4-mini", reasoningEffort: "high" });
  assert.deepEqual(result, { queued: true, code: "300308.SZ", model: "gpt-5.4-mini", reasoningEffort: "high", status: "queued", jobId: "job-1", deduplicated: false });
});

test("CLI rejects unsupported model and reasoning values before a request", () => {
  assert.throws(() => parseArgs(["300308.SZ", "--model", "unknown"]), /unsupported model/);
  assert.throws(() => parseArgs(["300308.SZ", "--reasoning-effort", "extreme"]), /unsupported reasoning effort/);
});
