import type { Context } from "hono";
import { getHttpCache, putHttpCache } from "../db/queries";
import type { ApiFailure, ApiSuccess, Bindings } from "../types";

export type ExternalHttpOptions = {
  proxyEnabled?: boolean;
  proxyUrl?: string;
  proxyDomains?: string[];
  domainConcurrency?: number;
  includeSensitiveHeaders?: boolean;
  cacheKey?: string;
  cacheTtlMs?: number;
};

const domainLimiters = new Map<string, DomainLimiter>();

export function ok<T>(c: Context, data: T): Response {
  const body: ApiSuccess<T> = { code: 200, msg: "OK", data };
  return c.json(body);
}

export function fail(c: Context, status: number, message: string): Response {
  const body: ApiFailure = { code: status, msg: message, data: null };
  return c.json(body, status as never);
}

export function requireQuery(c: Context, key: string): string | Response {
  const value = c.req.query(key)?.trim() ?? "";
  if (!value) {
    return fail(c, 400, `Missing ${key} parameter`);
  }
  return value;
}

export async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const text = await fetchText(url, init);
  return parseJsonOrJsonp(text);
}

export async function cachedFetchJson(
  db: D1Database,
  url: string,
  init?: RequestInit,
  ttlMs = 60 * 60 * 1000,
  options?: ExternalHttpOptions
): Promise<unknown> {
  const text = await cachedFetchText(db, url, init, ttlMs, options);
  return parseJsonOrJsonp(text);
}

export async function cachedFetchText(
  db: D1Database,
  url: string,
  init?: RequestInit,
  ttlMs = 60 * 60 * 1000,
  options?: ExternalHttpOptions
): Promise<string> {
  const request = normalizeRequest(url, init);
  const cacheKey = options?.cacheKey || await digestHex(JSON.stringify(request));
  const cacheTtlMs = options?.cacheTtlMs ?? ttlMs;
  const cached = await getHttpCache(db, cacheKey);
  if (cached) {
    return cached.bodyText;
  }
  const { status, headers, text } = await fetchTextResponse(url, init, options);
  const now = Date.now();
  await putHttpCache(db, {
    cacheKey,
    url,
    method: request.method,
    status,
    headersJson: JSON.stringify(headers),
    bodyText: text,
    expiresAt: now + Math.max(1, cacheTtlMs),
    updatedAt: now,
  });
  return text;
}

export async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const { text } = await fetchTextResponse(url, init);
  return text;
}

async function fetchTextResponse(
  url: string,
  init?: RequestInit,
  options?: ExternalHttpOptions
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const host = new URL(url).hostname.toLowerCase();
  return runWithDomainLimit(host, options?.domainConcurrency ?? 3, async () => {
    if (shouldUseProxy(url, options)) {
      return fetchTextViaProxy(options!.proxyUrl!, url, init, options);
    }
    const res = await fetch(url, {
      ...init,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; stock-info-worker/0.1; +https://workers.cloudflare.com/)",
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`request failed: status=${res.status} body=${truncate(text)}`);
    }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text };
  });
}

async function fetchTextViaProxy(
  proxyUrl: string,
  url: string,
  init?: RequestInit,
  options?: ExternalHttpOptions
): Promise<{
  status: number;
  headers: Record<string, string>;
  text: string;
}> {
  const headers = normalizeOutgoingHeaders(init?.headers, options);
  const res = await fetch(proxyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`proxy request failed: status=${res.status} body=${truncate(text)}`);
  }
  const parsed = JSON.parse(text) as {
    status?: number;
    headers?: Record<string, string>;
    bodyText?: string;
  };
  const status = parsed.status ?? 502;
  const bodyText = parsed.bodyText ?? "";
  if (status < 200 || status >= 300) {
    throw new Error(`request failed: status=${status} body=${truncate(bodyText)}`);
  }
  return { status, headers: parsed.headers ?? {}, text: bodyText };
}

export function externalHttpOptions(env: Partial<Bindings>): ExternalHttpOptions {
  return {
    proxyEnabled: isTruthy(env.HTTP_PROXY_ENABLED) || Boolean(env.LOCAL_FETCH_PROXY_URL),
    proxyUrl: env.HTTP_PROXY_URL || env.LOCAL_FETCH_PROXY_URL,
    proxyDomains: parseDomains(env.HTTP_PROXY_DOMAINS),
    domainConcurrency: positiveInt(env.HTTP_DOMAIN_CONCURRENCY) ?? 3,
  };
}

function shouldUseProxy(url: string, options?: ExternalHttpOptions): boolean {
  if (!options?.proxyUrl || options.proxyEnabled === false) {
    return false;
  }
  const domains = options.proxyDomains ?? [];
  if (domains.length === 0) {
    return true;
  }
  const host = new URL(url).hostname.toLowerCase();
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function parseDomains(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(",") : value ?? "";
  return raw
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/^\./, "").replace(/\/$/, ""))
    .filter(Boolean);
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isTruthy(value: string | undefined): boolean {
  const text = String(value || "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

async function runWithDomainLimit<T>(host: string, concurrency: number, fn: () => Promise<T>): Promise<T> {
  const limit = Math.max(1, concurrency || 3);
  let limiter = domainLimiters.get(host);
  if (!limiter || limiter.limit !== limit) {
    limiter = new DomainLimiter(limit);
    domainLimiters.set(host, limiter);
  }
  return limiter.run(fn);
}

class DomainLimiter {
  active = 0;
  queue: Array<() => void> = [];

  constructor(public readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

export function parseJsonOrJsonp(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  const start = trimmed.indexOf("(");
  const end = trimmed.lastIndexOf(")");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start + 1, end));
  }
  throw new Error(`invalid json/jsonp body: ${truncate(trimmed)}`);
}

export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "object" && "raw" in value) {
    return numberOrNull((value as { raw?: unknown }).raw);
  }
  const num = typeof value === "number" ? value : Number(String(value).replaceAll(",", ""));
  return Number.isFinite(num) ? num : null;
}

export function truncate(value: string, max = 300): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function normalizeRequest(url: string, init?: RequestInit): {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
} {
  return {
    method: (init?.method ?? "GET").toUpperCase(),
    url,
    headers: normalizeHeaders(init?.headers),
    body: typeof init?.body === "string" ? init.body : null,
  };
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) {
    return result;
  }
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers);
  for (const [key, value] of entries) {
    const lowered = key.toLowerCase();
    if (lowered === "authorization" || lowered === "cookie") {
      result[lowered] = "<redacted>";
    } else {
      result[lowered] = String(value);
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function normalizeOutgoingHeaders(
  headers: HeadersInit | undefined,
  options?: { includeSensitiveHeaders?: boolean }
): Record<string, string> {
  if (options?.includeSensitiveHeaders) {
    return normalizeHeadersForOutgoing(headers);
  }
  const result = normalizeHeaders(headers);
  delete result.authorization;
  delete result.cookie;
  return result;
}

function normalizeHeadersForOutgoing(headers: HeadersInit | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) {
    return result;
  }
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers);
  for (const [key, value] of entries) {
    result[key] = String(value);
  }
  return result;
}

async function digestHex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}
