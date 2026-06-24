import type { Context } from "hono";
import type { ApiFailure, ApiSuccess } from "../types";

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

export async function fetchText(url: string, init?: RequestInit): Promise<string> {
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
  return text;
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
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

export function truncate(value: string, max = 300): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
