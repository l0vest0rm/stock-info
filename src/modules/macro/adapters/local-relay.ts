import type { MacroFetch } from "./types";

export function macroFetch(env: { MACRO_FETCH_RELAY_URL?: string }): MacroFetch {
  const relayUrl = env.MACRO_FETCH_RELAY_URL?.trim();
  if (!relayUrl) return fetch;
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    return fetch(relayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: init.signal,
      body: JSON.stringify({
        url: String(input),
        method: init.method ?? "GET",
        headers,
        body: typeof init.body === "string" ? init.body : undefined,
      }),
    });
  }) as MacroFetch;
}
