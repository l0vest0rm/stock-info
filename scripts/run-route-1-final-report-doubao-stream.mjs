#!/usr/bin/env node

/**
 * Runs the Route 1 single-prompt research report through the shared llm-client
 * Responses/SSE transport. The prompt is sent verbatim as the sole user input.
 */

import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { createResponsesProvider } from "@m2ai/shared-llm-client";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const DEFAULT_MODEL = "doubao-seed-2-0-mini-260215";
const PROMPT_PATH = resolve(ROOT, "data/diagnostics/prompt-proposals/route-1-single-final-prompt-300308.SZ.md");
const ARK_THINKING_TYPE = "enabled";
const ARK_REASONING_EFFORT = "high";
const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const REQUEST_TIMEOUT_MS = 90 * 60_000;
const STREAM_IDLE_TIMEOUT_MS = 10 * 60_000;
const STREAM_FIRST_RESPONSE_TIMEOUT_MS = 15 * 60_000;

function parseArgs(argv) {
  const args = { model: DEFAULT_MODEL, out: null, overwrite: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/run-route-1-final-report-doubao-stream.mjs [--model model-id] [--out path] [--overwrite]");
      process.exit(0);
    }
    if (arg === "--overwrite") {
      args.overwrite = true;
      continue;
    }
    if (arg !== "--out" && arg !== "--model") throw new Error(`unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || String(value).startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--out") args.out = resolve(String(value));
    else args.model = String(value).trim();
    index += 1;
  }
  if (!args.model) throw new Error("--model must be non-empty");
  args.out ||= resolve(ROOT, `data/diagnostics/route-1-single-final-300308.SZ-${args.model.replace(/[^A-Za-z0-9._-]/g, "_")}-ark-thinking-high.md`);
  return args;
}

function webSearchMetadataPath(markdownPath) {
  return markdownPath.endsWith(".md")
    ? `${markdownPath.slice(0, -3)}.web-search.json`
    : `${markdownPath}.web-search.json`;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The shared client owns Responses/SSE parsing. Ark's thinking controls use
 * an additional request field, so adapt only this provider request
 * immediately before it is sent. The Ark Responses endpoint rejects the
 * Chat-Completions-style top-level `reasoning_effort`; its accepted depth
 * field is the shared client's `reasoning.effort` object.
 */
async function arkResponsesFetch(input, init = {}) {
  const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Ark Responses request body must be a JSON object");
  }
  body.thinking = { type: ARK_THINKING_TYPE };
  return fetch(input, { ...init, body: JSON.stringify(body) });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.overwrite && await exists(args.out)) {
    throw new Error(`output already exists: ${args.out}; pass --overwrite or choose --out`);
  }

  const apiKey = String(process.env.ARK_API_KEY || process.env.VOLC_ARK_API_KEY || "").trim();
  if (!apiKey) throw new Error("missing VOLC_ARK_API_KEY or ARK_API_KEY for the Doubao Ark endpoint");
  const prompt = await readFile(PROMPT_PATH, "utf8");
  if (!prompt.trim()) throw new Error(`prompt is empty: ${PROMPT_PATH}`);

  const provider = createResponsesProvider({
    name: "volc-ark",
    baseUrl: String(process.env.DOUBAO_BASE_URL || ARK_BASE_URL).replace(/\/+$/, ""),
    apiKey,
    fetchImpl: arkResponsesFetch,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    streamFirstResponseTimeoutMs: STREAM_FIRST_RESPONSE_TIMEOUT_MS,
  });
  const startedAt = Date.now();
  const requestId = `route-1-final-report:300308.SZ:${randomUUID()}`;
  let streamedText = "";
  let lastReportedLength = 0;
  let latestWebSearch = { searched: false, queries: [], citations: [] };
  console.error(`[route-1-doubao] streaming model=${args.model} thinking=${ARK_THINKING_TYPE} reasoning.effort=${ARK_REASONING_EFFORT} web_search=required prompt=${PROMPT_PATH}`);

  const result = await provider.stream({
    requestId,
    model: args.model,
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    reasoningEffort: ARK_REASONING_EFFORT,
    // Ark's Responses web search does not accept the OpenAI-specific
    // `search_context_size` field emitted by the shared client.
    tools: [{ type: "web_search" }],
    toolChoice: "required",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    onWebSearch(metadata) {
      latestWebSearch = metadata;
      console.error(`\n[route-1-doubao] web_search searched=${metadata.searched} queries=${metadata.queries.length} citations=${metadata.citations.length}`);
    },
    onText(delta) {
      streamedText += delta;
      process.stdout.write(delta);
      if (streamedText.length - lastReportedLength >= 2_000) {
        lastReportedLength = streamedText.length;
        console.error(`\n[route-1-doubao] received=${streamedText.length} chars elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`);
      }
    },
  });

  const markdown = result.text || streamedText;
  if (!markdown.trim()) throw new Error("stream completed without report text");
  await writeFile(args.out, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf8");
  const webSearch = result.webSearch || latestWebSearch;
  const metadataPath = webSearchMetadataPath(args.out);
  await writeFile(metadataPath, `${JSON.stringify({ requestId, model: args.model, thinking: { type: ARK_THINKING_TYPE }, reasoning: { effort: ARK_REASONING_EFFORT }, webSearch }, null, 2)}\n`, "utf8");
  console.error(`\n[route-1-doubao] saved=${args.out} metadata=${metadataPath} chars=${markdown.length} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`);
}

await main();
