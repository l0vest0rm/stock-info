import type { MacroFetch } from "./types";

const OFFICIAL_MACRO_HOSTS = new Set([
  "api.bls.gov",
  "www.bls.gov",
  "api.stlouisfed.org",
  "fred.stlouisfed.org",
  "api.db.nomics.world",
]);

/**
 * Macro adapters may only contact their documented provider endpoints. Both
 * runtimes use their native fetch implementation; local Node intentionally
 * has no loopback relay or second service lifecycle. DBnomics is restricted
 * to catalog mappings with a separately verified source publication contract.
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
