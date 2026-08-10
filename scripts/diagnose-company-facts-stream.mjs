#!/usr/bin/env node

/**
 * Read-only, direct Responses/SSE probe for one persisted investment-analysis
 * stage. It does not enqueue a task, write D1, or import the production runner.
 *
 * The baseline is reconstructed from the nearest persisted completed artifact
 * for company_facts (normally attempt 2 immediately before the failed attempt).
 * The provider's streaming transport contract is deliberate here: stream is
 * always true and max_output_tokens is omitted, exactly as the current shared
 * Responses provider prepares a streaming request. Variants only remove or
 * minimize one request dimension at a time.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const DEFAULT_DB = resolve(ROOT, "data/local/stock-info.sqlite");
const DEFAULT_CONFIG = resolve(ROOT, "config/research-operating-analysis.json");
const DEFAULT_BASE_URL = "https://api.m2ai.cc/api/v1/openai";
const STAGE_KEY = "company_facts";
const DEFAULT_CODE = "300308.SZ";
const INSTRUCTIONS_FALLBACK = "你是严谨的投资研究员。只使用本阶段允许的证据；不以模型记忆填补缺口；严格按输出格式返回。";

function parseArgs(argv) {
  // Keep the default experiment to the fixed prompt/model/streaming contract
  // and one allowed reasoning-effort discriminator. Other request-field
  // minimizers remain opt-in via --variants for a later, explicitly requested
  // probe.
  const args = { code: DEFAULT_CODE, variants: "baseline,reasoning-none" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/diagnose-company-facts-stream.mjs [--code 300308.SZ] [--source-run-id llm-run:...] [--variants baseline,tool-choice-auto,reasoning-none,no-tools,empty-input] [--out path]");
      process.exit(0);
    }
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (value === undefined || String(value).startsWith("--")) throw new Error(`missing value for ${arg}`);
    args[key] = String(value);
    i += 1;
  }
  args.variants = String(args.variants).split(",").map((item) => item.trim()).filter(Boolean);
  if (!args.variants.length) throw new Error("--variants must contain at least one variant");
  return args;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function jsonOrNull(value) {
  try { return JSON.parse(String(value)); } catch { return null; }
}

function redacted(value) {
  let text = String(value ?? "");
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]");
  text = text.replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret|cookie)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  text = text.replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|cookie)=)[^&#\s]+/gi, "$1[REDACTED]");
  return text;
}

function safeError(error) {
  return redacted(error instanceof Error ? error.message : String(error)).slice(0, 1800);
}

function isoNow() { return new Date().toISOString(); }

function compactHeaders(headers) {
  const allowed = ["content-type", "content-length", "date", "server", "x-request-id", "cf-ray", "cf-cache-status"];
  return Object.fromEntries(allowed.map((name) => [name, headers.get(name)]).filter(([, value]) => value !== null));
}

function firstSseBoundary(buffer) {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : null;
}

function parseSseFrame(frame) {
  const data = frame.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim()).filter((line) => line && line !== "[DONE]").join("\n");
  const value = data ? jsonOrNull(data) : null;
  return { data, value, type: typeof value?.type === "string" ? value.type : "unparsed" };
}

function responseNode(value) {
  if (value?.response && typeof value.response === "object") return value.response;
  return value && typeof value === "object" ? value : {};
}

function responseId(value) {
  const response = responseNode(value);
  return typeof response.id === "string" ? response.id : typeof value?.id === "string" ? value.id : null;
}

function terminalInfo(value, type) {
  const response = responseNode(value);
  return {
    type,
    responseId: responseId(value),
    responseStatus: typeof response.status === "string" ? response.status : null,
    incompleteDetails: response.incomplete_details || null,
    error: response.error || value?.error || null,
    usage: response.usage || null,
  };
}

function initialResult(spec, requestBody) {
  return {
    variant: spec.variant,
    requestId: spec.requestId,
    request: {
      method: "POST",
      url: spec.safeUrl,
      stream: requestBody.stream === true,
      model: requestBody.model,
      reasoning: requestBody.reasoning || null,
      toolCount: Array.isArray(requestBody.tools) ? requestBody.tools.length : 0,
      toolChoice: requestBody.tool_choice ?? null,
      instructionChars: String(requestBody.instructions || "").length,
      userPromptChars: String(requestBody.input?.[0]?.content?.[0]?.text || "").length,
      bodyBytes: byteLength(JSON.stringify(requestBody)),
      bodySha256: sha256(JSON.stringify(requestBody)),
    },
    startedAt: isoNow(),
    httpResponseAt: null,
    firstTransportAt: null,
    firstEventAt: null,
    lastEventAt: null,
    transportEndedAt: null,
    endedAt: null,
    httpStatus: null,
    responseHeaders: {},
    transportChunks: 0,
    transportBytes: 0,
    eventCount: 0,
    eventTypes: {},
    eventTimeline: [],
    textDeltaCount: 0,
    textDeltaChars: 0,
    reasoningDeltaCount: 0,
    reasoningDeltaChars: 0,
    outputChars: 0,
    outputSha256: null,
    outputHasher: createHash("sha256"),
    reasoningChars: 0,
    responseId: null,
    terminal: null,
    eof: false,
    timedOut: false,
    error: null,
  };
}

function recordFrame(state, frame, elapsed) {
  if (!frame.trim()) return;
  const parsed = parseSseFrame(frame);
  const type = parsed.type;
  state.eventCount += 1;
  state.eventTypes[type] = (state.eventTypes[type] || 0) + 1;
  const at = { at: isoNow(), elapsedMs: Number(elapsed().toFixed(1)) };
  state.firstEventAt ||= at;
  state.lastEventAt = at;
  // Keep only a compact timeline. Payload text/URLs are intentionally omitted.
  if (state.eventTimeline.length < 12 || ["response.completed", "response.failed", "response.incomplete"].includes(type)) {
    state.eventTimeline.push({ index: state.eventCount, type, ...at });
  }
  if (type === "response.created") state.responseId ||= responseId(parsed.value);
  if (type === "response.output_text.delta" && typeof parsed.value?.delta === "string") {
    state.textDeltaCount += 1;
    state.textDeltaChars += parsed.value.delta.length;
    state.outputHasher.update(parsed.value.delta, "utf8");
  }
  if (type === "response.output_text.done" && typeof parsed.value?.text === "string") {
    if (state.textDeltaCount === 0) state.outputHasher.update(parsed.value.text, "utf8");
    state.outputChars += parsed.value.text.length;
  }
  if ((type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") && typeof parsed.value?.delta === "string") {
    state.reasoningDeltaCount += 1;
    state.reasoningDeltaChars += parsed.value.delta.length;
  }
  if ((type === "response.reasoning_text.done" || type === "response.reasoning_summary_text.done") && typeof parsed.value?.text === "string") state.reasoningChars += parsed.value.text.length;
  if (["response.completed", "response.failed", "response.incomplete"].includes(type)) {
    state.responseId ||= responseId(parsed.value);
    state.terminal = terminalInfo(parsed.value, type);
  }
  if (state.eventCount === 1 || state.eventCount % 25 === 0 || state.terminal) {
    console.error(`[diagnose-company-facts-stream] event variant=${state.variant} n=${state.eventCount} type=${type} textChars=${state.textDeltaChars} response=${state.responseId || "none"} terminal=${state.terminal?.type || "none"}`);
  }
}

async function readWithIdleTimeout(reader, idleMs, signal) {
  if (signal?.aborted) throw signal.reason || new Error("request aborted");
  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finishReject(Object.assign(new Error(`LLM stream stalled for ${idleMs}ms without SSE activity`), { code: "stream_idle_timeout" })), idleMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => finishReject(signal.reason || new Error("request aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.read().then(finishResolve, finishReject);
  });
}

async function runStream({ spec, requestBody, baseUrl, apiKey, jobTimeoutMs, idleTimeoutMs }) {
  const state = initialResult(spec, requestBody);
  const monotonicStart = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - monotonicStart) / 1e6;
  const controller = new AbortController();
  const wholeTimer = setTimeout(() => controller.abort(Object.assign(new Error(`LLM diagnostic request exceeded configured ${jobTimeoutMs}ms job timeout`), { code: "job_timeout" })), jobTimeoutMs);
  let reader;
  let buffer = "";
  let decoder;
  try {
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        "x-client-request-id": spec.requestId,
      },
      body: JSON.stringify(requestBody),
    });
    state.httpStatus = response.status;
    state.httpResponseAt = { at: isoNow(), elapsedMs: Number(elapsed().toFixed(1)) };
    state.responseHeaders = compactHeaders(response.headers);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`responses stream failed: status=${response.status} body=${redacted(text).slice(0, 800)}`);
    }
    if (!response.body) throw new Error("responses stream body is empty");
    reader = response.body.getReader();
    decoder = new TextDecoder();
    while (true) {
      const chunk = await readWithIdleTimeout(reader, idleTimeoutMs, controller.signal);
      if (chunk.done) {
        buffer += decoder.decode();
        state.eof = true;
        state.transportEndedAt = { at: isoNow(), elapsedMs: Number(elapsed().toFixed(1)) };
        const tail = buffer.trim();
        if (tail) { recordFrame(state, tail, elapsed); buffer = ""; }
        break;
      }
      if (!chunk.value) continue;
      state.transportChunks += 1;
      state.transportBytes += chunk.value.byteLength;
      state.firstTransportAt ||= { at: isoNow(), elapsedMs: Number(elapsed().toFixed(1)) };
      buffer += decoder.decode(chunk.value, { stream: true });
      while (true) {
        const boundary = firstSseBoundary(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        recordFrame(state, frame, elapsed);
      }
    }
    // Stream completion is valid only when the protocol emits response.completed.
    if (!state.terminal) state.error = "stream ended before response.completed";
  } catch (error) {
    state.timedOut = error?.code === "stream_idle_timeout" || error?.code === "job_timeout" || controller.signal.aborted;
    state.error = safeError(error);
    if (state.eof && !state.terminal) state.error = "stream ended before response.completed";
  } finally {
    clearTimeout(wholeTimer);
    state.endedAt = { at: isoNow(), elapsedMs: Number(elapsed().toFixed(1)) };
    if (reader) await reader.cancel().catch(() => undefined);
    state.outputSha256 = state.outputHasher.digest("hex");
    delete state.outputHasher;
  }
  return state;
}

function sourcePromptWithoutInput(prompt) {
  const userPrompt = String(prompt.userPrompt || "");
  return userPrompt.replace(/<input_data>[\s\S]*?<\/input_data>/, "<input_data>{}</input_data>");
}

function requestForVariant(source, variant, safeUrl) {
  const base = {
    model: source.prompt.model || "gpt-5.6-luna",
    instructions: source.prompt.instructions || INSTRUCTIONS_FALLBACK,
    input: [{ role: "user", content: [{ type: "input_text", text: source.prompt.userPrompt }] }],
    store: false,
    reasoning: { effort: source.reasoningEffort || "max" },
    tools: [{ type: "web_search", search_context_size: source.searchContextSize || "high" }],
    tool_choice: "required",
    stream: true,
  };
  if (variant === "tool-choice-auto") delete base.tool_choice;
  else if (variant === "reasoning-none") base.reasoning = { effort: "none" };
  else if (variant === "no-tools") { delete base.tools; delete base.tool_choice; }
  else if (variant === "empty-input") base.input[0].content[0].text = sourcePromptWithoutInput(source.prompt);
  else if (variant !== "baseline") throw new Error(`unsupported variant: ${variant}`);
  return { body: base, safeUrl };
}

function loadPersistedSource({ dbPath, code, sourceRunId }) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const failed = db.prepare(`
      SELECT t.task_id AS taskId, r.run_id AS runId, r.attempt, a.terminal_metadata_json AS metadataJson,
             r.started_at AS startedAt
      FROM llm_tasks t JOIN llm_runs r ON r.task_id=t.task_id
      JOIN llm_run_artifacts a ON a.run_id=r.run_id AND a.step_key=?
      WHERE t.target_id=? AND t.stage_key=? AND r.status='failed'
      ORDER BY r.started_at DESC LIMIT 1
    `).get(STAGE_KEY, code, STAGE_KEY);
    const rows = sourceRunId
      ? db.prepare(`SELECT t.task_id AS taskId, r.run_id AS runId, r.attempt, a.terminal_metadata_json AS metadataJson
          FROM llm_tasks t JOIN llm_runs r ON r.task_id=t.task_id JOIN llm_run_artifacts a ON a.run_id=r.run_id AND a.step_key=?
          WHERE r.run_id=? LIMIT 1`).all(STAGE_KEY, sourceRunId)
      : db.prepare(`SELECT t.task_id AS taskId, r.run_id AS runId, r.attempt, a.terminal_metadata_json AS metadataJson
          FROM llm_tasks t JOIN llm_runs r ON r.task_id=t.task_id JOIN llm_run_artifacts a ON a.run_id=r.run_id AND a.step_key=?
          WHERE t.target_id=? AND t.stage_key=? AND a.status='complete'
          ORDER BY (t.task_id=? ) DESC, (r.attempt < ?) DESC, r.completed_at DESC`).all(STAGE_KEY, code, STAGE_KEY, failed?.taskId || "", failed?.attempt || 0);
    const candidate = rows.find((row) => {
      const metadata = jsonOrNull(row.metadataJson);
      return metadata?.prompt && typeof metadata.prompt.userPrompt === "string" && metadata?.input && typeof metadata.input === "object";
    });
    if (!candidate) throw new Error("no persisted complete company_facts prompt/input found; the failed row was overwritten by failure persistence");
    const metadata = jsonOrNull(candidate.metadataJson);
    return {
      source: { runId: candidate.runId, taskId: candidate.taskId, attempt: candidate.attempt },
      failed: failed ? { runId: failed.runId, taskId: failed.taskId, attempt: failed.attempt, error: jsonOrNull(failed.metadataJson)?.input?.error || null } : null,
      prompt: metadata.prompt,
      input: metadata.input,
      reasoningEffort: metadata.prompt.reasoningEffort || "max",
      searchContextSize: "high",
    };
  } finally { db.close(); }
}

function summarizePersistedSource(source) {
  return {
    source: source.source,
    failed: source.failed ? {
      runId: source.failed.runId,
      taskId: source.failed.taskId,
      attempt: source.failed.attempt,
      error: redacted(source.failed.error || "").slice(0, 1000),
    } : null,
    prompt: {
      model: source.prompt.model || null,
      instructionsChars: String(source.prompt.instructions || "").length,
      userPromptChars: String(source.prompt.userPrompt || "").length,
      userPromptSha256: sha256(source.prompt.userPrompt || ""),
    },
    input: {
      keys: Object.keys(source.input || {}).sort(),
      bytes: byteLength(JSON.stringify(source.input || {})),
      sha256: sha256(JSON.stringify(source.input || {})),
      inputFingerprint: source.input?.inputFingerprint || source.input?.context?.inputFingerprint || null,
    },
    reasoningEffort: source.reasoningEffort,
    searchContextSize: source.searchContextSize,
  };
}

async function resolveApiKey() {
  const direct = String(process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || "").trim();
  if (direct) return direct;
  try {
    const auth = jsonOrNull(await readFile(`${process.env.HOME}/.codex/auth.json`, "utf8"));
    return String(auth?.OPENAI_API_KEY || "").trim();
  } catch { return ""; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = resolve(args.db || DEFAULT_DB);
  const configPath = resolve(args.config || DEFAULT_CONFIG);
  const config = jsonOrNull(await readFile(configPath, "utf8"));
  if (!config) throw new Error(`cannot load config: ${configPath}`);
  const source = loadPersistedSource({ dbPath, code: args.code, sourceRunId: args.sourceRunId });
  const baseUrl = String(args.baseUrl || process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const safeUrl = (() => { try { const url = new URL(baseUrl); return `${url.origin}${url.pathname}`.replace(/\/+$/, ""); } catch { return redacted(baseUrl); } })();
  const apiKey = await resolveApiKey();
  if (!apiKey) throw new Error("missing OPENAI_API_KEY/LLM_API_KEY or ~/.codex/auth.json");
  const jobTimeoutMs = Number(config.webSearchJobTimeoutMs || config.jobTimeoutMs || 3_600_000);
  const idleTimeoutMs = Number(config.streamIdleTimeoutMs || 90_000);
  const results = [];
  for (const variant of args.variants) {
    const request = requestForVariant(source, variant, safeUrl);
    const requestId = `diagnostic-company-facts:${args.code}:${variant}:${randomUUID()}`;
    console.error(`[diagnose-company-facts-stream] start ${variant} prompt=${request.body.input[0].content[0].text.length} body=${byteLength(JSON.stringify(request.body))}`);
    const result = await runStream({ spec: { variant, requestId, safeUrl }, requestBody: request.body, baseUrl, apiKey, jobTimeoutMs, idleTimeoutMs });
    results.push(result);
    console.error(`[diagnose-company-facts-stream] end ${variant} status=${result.httpStatus} events=${result.eventCount} textChars=${result.textDeltaChars} terminal=${result.terminal?.type || "none"} elapsedMs=${result.endedAt?.elapsedMs ?? "?"}`);
  }
  const output = {
    generatedAt: isoNow(),
    code: args.code,
    stageKey: STAGE_KEY,
    transport: { stream: true, maxOutputTokensSent: false, jobTimeoutMs, streamIdleTimeoutMs: idleTimeoutMs, baseUrl: safeUrl },
    persisted: {
      source: summarizePersistedSource(source),
      note: "The failed attempt's original input/prompt is overwritten by failure persistence; baseline uses the nearest persisted complete artifact from the same child task when available.",
    },
    variants: results,
  };
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (args.out) await writeFile(resolve(args.out), serialized, "utf8");
  process.stdout.write(serialized);
}

main().catch((error) => { console.error(`[diagnose-company-facts-stream] fatal: ${safeError(error)}`); process.exitCode = 1; });
