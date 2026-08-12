import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { GENERIC_LLM_HANDLER_KEYS, listGenericLlmHandlers, selectGenericLlmHandler } from "./generic-llm-handler-registry.mjs";

test("generic dispatcher does not retain retired company-discovery handlers", () => {
  assert.equal(selectGenericLlmHandler("company_report_discovery"), null);
  assert.equal(selectGenericLlmHandler({ taskType: "information_processing" })?.family, "knowledge");
  assert.equal(selectGenericLlmHandler("research_web_search"), null);
  assert.equal(selectGenericLlmHandler("does_not_exist"), null);
  assert.deepEqual(listGenericLlmHandlers().map((handler) => handler.key), [...GENERIC_LLM_HANDLER_KEYS]);
});

test("local runtime does not retain retired company-discovery or package lanes", async () => {
  const config = JSON.parse(await readFile(new URL("../../config/local-job-runtime.json", import.meta.url), "utf8"));
  assert.equal(config.provider.globalConcurrency, 5);
  assert.equal("companyReportDiscovery" in config.handlers, false);
  assert.equal("researchWebSearch" in config.handlers, false);
});
