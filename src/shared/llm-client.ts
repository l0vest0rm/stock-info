import { getLlmCache, putLlmCache } from "../db/queries";
import type { Bindings } from "../types";

export type SupportedLlmModel = "gpt-5.4-mini" | "doubao-seed-2-0-mini-260215";

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmTextRequest = {
  model: SupportedLlmModel;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  cacheTtlMs?: number;
};

export type LlmTextResponse = {
  model: SupportedLlmModel;
  text: string;
  cached: boolean;
  raw: unknown;
};

const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function requestLlmText(
  env: Bindings,
  request: LlmTextRequest
): Promise<LlmTextResponse> {
  const provider = providerForModel(request.model);
  const requestJson = stableJson({
    model: request.model,
    messages: request.messages,
    temperature: request.temperature ?? 0,
    maxTokens: request.maxTokens ?? 2048,
  });
  const cacheKey = await digestHex(`${provider}:${requestJson}`);
  const cached = await getLlmCache(env.DB, cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached.responseJson) as LlmTextResponse;
    return { ...parsed, cached: true };
  }

  const { baseUrl, apiKey } = llmEndpoint(env, provider);
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0,
      max_tokens: request.maxTokens ?? 2048,
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`llm request failed: status=${response.status} body=${JSON.stringify(body).slice(0, 300)}`);
  }
  const text = extractText(body);
  const result: LlmTextResponse = { model: request.model, text, cached: false, raw: body };
  const now = Date.now();
  await putLlmCache(env.DB, {
    cacheKey,
    provider,
    model: request.model,
    requestJson,
    responseJson: JSON.stringify(result),
    expiresAt: now + Math.max(1, request.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS),
    updatedAt: now,
  });
  return result;
}

function providerForModel(model: SupportedLlmModel): "openai" | "doubao" {
  if (model === "gpt-5.4-mini") {
    return "openai";
  }
  if (model === "doubao-seed-2-0-mini-260215") {
    return "doubao";
  }
  throw new Error(`unsupported llm model: ${model}`);
}

function llmEndpoint(env: Bindings, provider: "openai" | "doubao"): { baseUrl: string; apiKey: string } {
  if (provider === "doubao") {
    const apiKey = env.VOLC_ARK_API_KEY ?? env.LLM_API_KEY;
    if (!apiKey) throw new Error("missing VOLC_ARK_API_KEY or LLM_API_KEY");
    return {
      apiKey,
      baseUrl: env.VOLC_ARK_BASE_URL ?? env.LLM_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3",
    };
  }
  const apiKey = env.OPENAI_API_KEY ?? env.LLM_API_KEY;
  if (!apiKey) throw new Error("missing OPENAI_API_KEY or LLM_API_KEY");
  return {
    apiKey,
    baseUrl: env.OPENAI_BASE_URL ?? env.LLM_BASE_URL ?? "https://api.openai.com/v1",
  };
}

function extractText(body: unknown): string {
  const content = (body as any)?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => item?.text ?? "").join("");
  }
  return "";
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortValue(item)])
    );
  }
  return value;
}

async function digestHex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}
