import type { MacroFetch } from "./types";

const OFFICIAL_MACRO_HOSTS = new Set([
  "api.bls.gov",
  "api.hkma.gov.hk",
  "api.stlouisfed.org",
  "fred.stlouisfed.org",
  "markets.newyorkfed.org",
]);

/**
 * Macro adapters may only contact their documented official sources. Both
 * runtimes use their native fetch implementation; local Node intentionally
 * has no loopback relay or second service lifecycle.
 */
export function macroFetch(_env: object): MacroFetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    if (url.protocol !== "https:" || !OFFICIAL_MACRO_HOSTS.has(url.hostname.toLowerCase())) {
      throw new Error(`macro source is not allowlisted: ${url.origin}`);
    }
    return fetch(input, init);
  }) as MacroFetch;
}
