#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createResponsesProvider } from "@m2ai/shared-llm-client";

const baseUrl = String(process.env.INFORMATION_PROCESSING_RUNNER_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const modelBaseUrl = String(process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || "https://api.m2ai.cc/api/v1/openai").replace(/\/+$/, "");
const apiKey = await resolveApiKey();
const pollIntervalMs = positiveInteger(process.env.INFORMATION_PROCESSING_RUNNER_POLL_INTERVAL_MS, 2_000);
let active = false;

if (!apiKey) throw new Error("local information processing runner requires OPENAI_API_KEY or ~/.codex/auth.json");

async function resolveApiKey() {
  if (typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim()) return process.env.OPENAI_API_KEY.trim();
  if (typeof process.env.LLM_API_KEY === "string" && process.env.LLM_API_KEY.trim()) return process.env.LLM_API_KEY.trim();
  try {
    const auth = JSON.parse(await readFile(`${process.env.HOME}/.codex/auth.json`, "utf8"));
    return typeof auth?.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY.trim() : "";
  } catch { return ""; }
}

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== 200) throw new Error(body?.msg || `information runner endpoint failed: ${response.status}`);
  return body.data;
}

async function poll() {
  if (active) return;
  active = true;
  try {
    const claimed = await request("/api/knowledge/processing-jobs/claim-next", { method: "POST" });
    const job = claimed?.job;
    if (!job) return;
    if (!job.request) {
      console.log(`[information-runner] ${job.status} ${job.documentId}`);
      return;
    }
    const startedAt = Date.now();
    console.log(`[information-runner] started ${job.documentId}`);
    try {
      const provider = createResponsesProvider({ name: "openai", baseUrl: modelBaseUrl, apiKey });
      const response = await provider.generate({
        model: job.request.model,
        instructions: job.request.instructions,
        input: [{ role: "user", content: [{ type: "input_text", text: job.request.input }] }],
        reasoningEffort: "low",
        maxOutputTokens: job.request.maxTokens,
      });
      const completed = await request(`/api/knowledge/processing-jobs/${encodeURIComponent(job.jobId)}/complete`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: job.request, text: response.text, raw: response.raw, cached: false }),
      });
      console.log(`[information-runner] ${completed.status} ${job.documentId} duration_ms=${Date.now() - startedAt}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await request(`/api/knowledge/processing-jobs/${encodeURIComponent(job.jobId)}/fail`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ request: job.request, error: message }),
        });
      } catch (failure) {
        console.error(`[information-runner] could not persist failure for ${job.documentId}`, failure);
      }
      console.error(`[information-runner] failed ${job.documentId} duration_ms=${Date.now() - startedAt}: ${message}`);
    }
  } catch (error) {
    console.error("[information-runner] claim failed", error);
  } finally {
    active = false;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 250 ? parsed : fallback;
}

console.log(`[information-runner] polling ${baseUrl} every ${pollIntervalMs}ms`);
void poll();
const timer = setInterval(() => { void poll(); }, pollIntervalMs);
process.once("SIGINT", () => { clearInterval(timer); process.exit(0); });
process.once("SIGTERM", () => { clearInterval(timer); process.exit(0); });
