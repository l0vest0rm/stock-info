import { readFile } from "node:fs/promises";
import { createResponsesProvider } from "@m2ai/shared-llm-client";

/** The three local handlers use one provider identity/configuration contract. */
export async function loadLocalJobRuntimeConfig() {
  return JSON.parse(await readFile(new URL("../../config/local-job-runtime.json", import.meta.url), "utf8"));
}

export async function resolveLocalJobApiKey() {
  if (typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim()) return process.env.OPENAI_API_KEY.trim();
  if (typeof process.env.LLM_API_KEY === "string" && process.env.LLM_API_KEY.trim()) return process.env.LLM_API_KEY.trim();
  try { const auth = JSON.parse(await readFile(`${process.env.HOME}/.codex/auth.json`, "utf8")); return typeof auth?.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY.trim() : ""; } catch { return ""; }
}

export function createLocalJobProvider(apiKey, { streamIdleTimeoutMs, streamFirstResponseTimeoutMs } = {}) {
  return createResponsesProvider({
    name: "openai",
    baseUrl: String(process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || "https://api.m2ai.cc/api/v1/openai").replace(/\/+$/, ""),
    apiKey,
    ...(streamIdleTimeoutMs ? { streamIdleTimeoutMs } : {}),
    ...(streamFirstResponseTimeoutMs ? { streamFirstResponseTimeoutMs } : {}),
  });
}
