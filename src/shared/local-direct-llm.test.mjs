import assert from "node:assert/strict";
import test from "node:test";

import { requestLocalDirectLlmText } from "./local-direct-llm.ts";

test("refuses a direct request outside the explicit local runtime", async () => {
  await assert.rejects(
    requestLocalDirectLlmText({ LLM_RUNTIME: "production", OPENAI_API_KEY: "test" }, {
      model: "gpt-5.6-luna",
      instructions: "must not reach the provider",
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    }),
    /disabled outside local Node development/,
  );
});

test("uses the Responses stream directly and forwards text deltas", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const answer = '{"forecasts":[{"year":2026,"netProfit":63}],"targetPrice":null}';
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response([
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: answer })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`,
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  };
  try {
    const deltas = [];
    const response = await requestLocalDirectLlmText({
      LLM_RUNTIME: "local",
      OPENAI_API_KEY: "test",
      OPENAI_BASE_URL: "https://proxy.example/v1",
    }, {
      model: "gpt-5.6-luna",
      instructions: "extract",
      input: [{ role: "user", content: [{ type: "input_text", text: "report" }] }],
      onText: (delta) => { deltas.push(delta); },
    });
    assert.equal(response.text, answer);
    assert.deepEqual(deltas, [answer]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://proxy.example/v1/responses");
    assert.equal(JSON.parse(calls[0].init.body).stream, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
