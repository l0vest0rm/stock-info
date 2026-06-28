import { SharedLlmClient, D1LlmCacheStore, createResponsesProvider } from "@m2ai/shared-llm-client/d1";
import { consumeDailyLlmQuota, releaseDailyLlmQuota } from "../db/queries";
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

const DEFAULT_REMOTE_DAILY_LIMIT = 300;
let cachedKey = "";
let cachedClient: SharedLlmClient | null = null;

export async function requestLlmText(
  env: Bindings,
  request: LlmTextRequest,
): Promise<LlmTextResponse> {
  const provider = providerForModel(request.model);
  const client = getSharedClient(env);
  const { instructions, input } = normalizeMessages(request.messages);
  const result = await client.generateText({
    provider,
    model: request.model,
    instructions,
    input,
    temperature: request.temperature ?? 0,
    maxOutputTokens: request.maxTokens ?? 2048,
    cacheTtlMs: request.cacheTtlMs,
  });
  return {
    model: request.model,
    text: result.text,
    cached: result.cached,
    raw: result.raw ?? null,
  };
}

function getSharedClient(env: Bindings): SharedLlmClient {
  const key = stableClientKey(env);
  if (cachedClient && cachedKey === key) {
    return cachedClient;
  }
  cachedKey = key;
  const providers: Record<string, ReturnType<typeof createResponsesProvider>> = {};
  const doubaoApiKey = requireOptionalEnv(env, ["VOLC_ARK_API_KEY", "LLM_API_KEY"]);
  const openaiApiKey = requireOptionalEnv(env, ["OPENAI_API_KEY", "LLM_API_KEY"]);
  if (doubaoApiKey) {
    providers.doubao = createResponsesProvider({
      name: "doubao",
      baseUrl: env.VOLC_ARK_BASE_URL ?? env.LLM_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: doubaoApiKey,
    });
  }
  if (openaiApiKey) {
    providers.openai = createResponsesProvider({
      name: "openai",
      baseUrl: env.OPENAI_BASE_URL ?? env.LLM_BASE_URL ?? "https://api.openai.com/v1",
      apiKey: openaiApiKey,
    });
  }
  cachedClient = new SharedLlmClient({
    cacheStore: new D1LlmCacheStore(env.DB),
    providers,
    providerConcurrency: {
      doubao: 3,
      openai: 3,
    },
    beforeRemoteCall: async (context) => {
      const limit = llmDailyLimit(env);
      const now = Date.now();
      const day = shanghaiDayStamp(now);
      const quotaKey = `llm-daily-quota:${day}`;
      const consumed = await consumeDailyLlmQuota(env.DB, quotaKey, limit, nextShanghaiDayTs(now), now);
      if (!consumed.allowed) {
        throw new Error(`llm daily limit exceeded: date=${day} limit=${limit} provider=${context.provider}`);
      }
      return { quotaKey };
    },
    afterRemoteError: async (lease) => {
      const quotaKey = (lease as { quotaKey?: string } | undefined)?.quotaKey;
      if (quotaKey) {
        await releaseDailyLlmQuota(env.DB, quotaKey, Date.now());
      }
    },
  });
  return cachedClient;
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

function normalizeMessages(messages: LlmMessage[]): {
  instructions: string;
  input: Array<{ role: "user" | "assistant" | "system"; content: Array<{ type: "input_text"; text: string }> }>;
} {
  const systemMessages = messages.filter((item) => item.role === "system").map((item) => item.content.trim()).filter(Boolean);
  const conversational = messages
    .filter((item) => item.role !== "system")
    .map((item) => ({
      role: item.role,
      content: [{ type: "input_text" as const, text: item.content }],
    }));
  return {
    instructions: systemMessages.join("\n\n"),
    input: conversational.length > 0 ? conversational : [{ role: "user", content: [{ type: "input_text", text: "" }] }],
  };
}

function llmDailyLimit(env: Bindings): number {
  const parsed = Number(requireOptionalEnv(env, ["LLM_DAILY_LIMIT"]) ?? "");
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_REMOTE_DAILY_LIMIT;
}

function requireOptionalEnv(env: Bindings, keys: Array<keyof Bindings>): string | undefined {
  for (const key of keys) {
    const direct = env[key];
    if (typeof direct === "string" && direct.trim()) {
      return direct.trim();
    }
    const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[String(key)];
    if (typeof processEnv === "string" && processEnv.trim()) {
      return processEnv.trim();
    }
  }
  return undefined;
}

function shanghaiDayStamp(now = Date.now()): string {
  const shifted = new Date(now + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function nextShanghaiDayTs(now = Date.now()): number {
  const shifted = now + 8 * 60 * 60 * 1000;
  const dayStartUtc = Date.parse(new Date(shifted).toISOString().slice(0, 10) + "T00:00:00.000Z");
  return dayStartUtc - 8 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000;
}

function stableClientKey(env: Bindings): string {
  return [
    env.OPENAI_BASE_URL ?? env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    env.VOLC_ARK_BASE_URL ?? env.LLM_BASE_URL ?? "https://ark.cn-beijing.volces.com/api/v3",
    requireOptionalEnv(env, ["OPENAI_API_KEY", "LLM_API_KEY"]) ?? "",
    requireOptionalEnv(env, ["VOLC_ARK_API_KEY", "LLM_API_KEY"]) ?? "",
  ].join("::");
}
