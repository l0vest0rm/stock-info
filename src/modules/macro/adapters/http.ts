import { MacroSourceError } from "./errors";
import type { MacroFetch } from "./types";

export async function fetchJson(
  sourceId: string,
  fetcher: MacroFetch,
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: { Accept: "application/json", ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new MacroSourceError(
      sourceId,
      timedOut ? "timeout" : "http_error",
      `${sourceId} request ${timedOut ? "timed out" : "failed"}`,
      true,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new MacroSourceError(sourceId, "http_error", `${sourceId} request failed: status=${response.status}`, response.status >= 500 || response.status === 429);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new MacroSourceError(sourceId, "invalid_response", `${sourceId} returned invalid JSON`, false, { cause: error });
  }
}

export async function fetchText(
  sourceId: string,
  fetcher: MacroFetch,
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: { Accept: "text/plain,text/csv,text/html", ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new MacroSourceError(
      sourceId,
      timedOut ? "timeout" : "http_error",
      `${sourceId} request ${timedOut ? "timed out" : "failed"}`,
      true,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new MacroSourceError(sourceId, "http_error", `${sourceId} request failed: status=${response.status}`, response.status >= 500 || response.status === 429);
  }
  return response.text();
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "" || value.trim() === ".") return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function recordArray(value: unknown): Record<string, unknown>[] | null {
  return Array.isArray(value) && value.every((item) => item !== null && typeof item === "object")
    ? value as Record<string, unknown>[]
    : null;
}
