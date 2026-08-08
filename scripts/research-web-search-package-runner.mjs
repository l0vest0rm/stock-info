#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createResponsesProvider } from "@m2ai/shared-llm-client";
import { fetchLocalWorker } from "./lib/local-worker-request.mjs";

const baseUrl = String(process.env.WEB_SEARCH_PACKAGE_RUNNER_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const apiKey = await resolveApiKey();
const modelBaseUrl = String(process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || "https://api.m2ai.cc/api/v1/openai").replace(/\/+$/, "");
const pollIntervalMs = positiveInteger(process.env.WEB_SEARCH_PACKAGE_RUNNER_POLL_INTERVAL_MS, 5_000);
let active = false;

if (!apiKey) throw new Error("local Web Search runner requires OPENAI_API_KEY or ~/.codex/auth.json");

async function resolveApiKey() {
  if (typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim()) return process.env.OPENAI_API_KEY.trim();
  if (typeof process.env.LLM_API_KEY === "string" && process.env.LLM_API_KEY.trim()) return process.env.LLM_API_KEY.trim();
  try {
    const auth = JSON.parse(await readFile(`${process.env.HOME}/.codex/auth.json`, "utf8"));
    return typeof auth?.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY.trim() : "";
  } catch { return ""; }
}

async function request(path, init) {
  const response = await fetchLocalWorker(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== 200) throw new Error(body?.msg || `local runner endpoint failed: ${response.status}`);
  return body.data;
}

async function poll() {
  if (active) return;
  active = true;
  try {
    const claimed = await request("/api/research/web-search-package-jobs/claim-next", { method: "POST" });
    if (!claimed?.request?.securityCode || !claimed?.request?.packageKind) return;
    const job = claimed.request;
    const startedAt = Date.now();
    console.log(`[web-search-runner] started ${job.securityCode} ${job.packageKind}`);
    try {
      const provider = createResponsesProvider({ name: "openai", baseUrl: modelBaseUrl, apiKey });
      const response = await provider.generate({
        model: job.model,
        instructions: job.instructions,
        input: [{ role: "user", content: [{ type: "input_text", text: job.input }] }],
        reasoningEffort: job.reasoningEffort,
        tools: [{ type: "web_search", searchContextSize: "high" }],
        toolChoice: "required",
        maxOutputTokens: job.maxOutputTokens,
        signal: AbortSignal.timeout(job.jobTimeoutMs),
      });
      await request(`/api/research/web-search-package-jobs/${encodeURIComponent(job.securityCode)}/${encodeURIComponent(job.packageKind)}/complete`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: job.model, text: response.text, webSearch: response.webSearch }),
      });
      console.log(`[web-search-runner] completed ${job.securityCode} ${job.packageKind} duration_ms=${Date.now() - startedAt}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await request(`/api/research/web-search-package-jobs/${encodeURIComponent(job.securityCode)}/${encodeURIComponent(job.packageKind)}/fail`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ error: message }),
        });
      } catch (failure) {
        console.error(`[web-search-runner] could not persist failure for ${job.securityCode} ${job.packageKind}`, failure);
      }
      console.error(`[web-search-runner] failed ${job.securityCode} ${job.packageKind} duration_ms=${Date.now() - startedAt}: ${message}`);
    }
  } catch (error) {
    console.error("[web-search-runner] claim failed", error);
  } finally {
    active = false;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 250 ? parsed : fallback;
}

console.log(`[web-search-runner] polling ${baseUrl} every ${pollIntervalMs}ms`);
void poll();
const timer = setInterval(() => { void poll(); }, pollIntervalMs);
process.once("SIGINT", () => { clearInterval(timer); process.exit(0); });
process.once("SIGTERM", () => { clearInterval(timer); process.exit(0); });
