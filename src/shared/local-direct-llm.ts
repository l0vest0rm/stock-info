import { createResponsesProvider } from "@m2ai/shared-llm-client";
import type { LlmInputMessage } from "@m2ai/shared-llm-client";
import type { Bindings } from "../types";
import type { LlmWebSearchMetadata, SupportedLlmModel } from "./llm-client";

export type LocalDirectLlmTextRequest = {
  model: SupportedLlmModel;
  instructions: string;
  input: LlmInputMessage[];
  maxTokens?: number;
  temperature?: number;
  onText?: (delta: string) => Promise<void> | void;
};

export type LocalDirectLlmTextResponse = {
  model: SupportedLlmModel;
  text: string;
  raw: unknown;
  webSearch?: LlmWebSearchMetadata;
};

/** Execute a small request-bound LLM operation without creating a scheduler task. */
export async function requestLocalDirectLlmText(
  env: Pick<Bindings, "LLM_RUNTIME" | "OPENAI_API_KEY" | "OPENAI_BASE_URL" | "LLM_API_KEY" | "LLM_BASE_URL">,
  request: LocalDirectLlmTextRequest,
): Promise<LocalDirectLlmTextResponse> {
  if (env.LLM_RUNTIME !== "local") {
    throw new Error("direct LLM calls are disabled outside local Node development");
  }
  const apiKey = text(env.OPENAI_API_KEY) || text(env.LLM_API_KEY);
  if (!apiKey) {
    throw new Error("local direct LLM credential is not configured");
  }
  const provider = createResponsesProvider({
    name: "openai",
    baseUrl: text(env.OPENAI_BASE_URL) || text(env.LLM_BASE_URL) || "https://api.m2ai.cc/api/v1/openai",
    apiKey,
  });
  const response = await provider.stream({
    model: request.model,
    instructions: request.instructions,
    input: request.input,
    maxOutputTokens: request.maxTokens,
    temperature: request.temperature,
    onText: request.onText,
  });
  return {
    model: request.model,
    text: response.text,
    raw: response.raw ?? null,
    ...(response.webSearch ? { webSearch: response.webSearch } : {}),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
