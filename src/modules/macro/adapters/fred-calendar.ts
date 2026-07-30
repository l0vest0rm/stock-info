import { MacroSourceError } from "./errors";
import { fetchJson, fetchText, recordArray } from "./http";
import type { MacroFetch } from "./types";

const SOURCE_ID = "fred-calendar";
const ENDPOINT = "https://api.stlouisfed.org/fred/releases/dates";
const PUBLIC_ENDPOINT = "https://fred.stlouisfed.org/releases/calendar";

export type FredReleaseDate = { releaseId: number; name: string; date: string; sourceUrl: string };

export async function loadFredReleaseCalendar(
  apiKeyValue: string | undefined,
  from: string,
  to: string,
  fetcher: MacroFetch = fetch,
  timeoutMs = 20_000,
): Promise<FredReleaseDate[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw new MacroSourceError(SOURCE_ID, "invalid_request", "FRED release calendar requires a valid date range", false);
  }
  if (!apiKeyValue?.trim()) return loadPublicReleaseCalendar(from, to, fetcher, timeoutMs);
  const apiKey = apiKeyValue.trim();
  const url = new URL(ENDPOINT);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("realtime_start", from);
  url.searchParams.set("realtime_end", to);
  url.searchParams.set("include_release_dates_with_no_data", "true");
  url.searchParams.set("limit", "1000");
  const publicUrl = new URL(url);
  publicUrl.searchParams.delete("api_key");
  const payload = await fetchJson(SOURCE_ID, fetcher, url.toString(), timeoutMs);
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const rows = recordArray(root?.release_dates);
  if (!rows) throw new MacroSourceError(SOURCE_ID, "invalid_response", "FRED calendar response is missing release_dates", false);
  return rows.flatMap((row) => {
    const releaseId = Number(row.release_id);
    const name = typeof row.release_name === "string" ? row.release_name.trim() : "";
    const date = typeof row.date === "string" ? row.date : "";
    return Number.isInteger(releaseId) && name && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? [{ releaseId, name, date, sourceUrl: publicUrl.toString() }]
      : [];
  });
}

async function loadPublicReleaseCalendar(from: string, to: string, fetcher: MacroFetch, timeoutMs: number): Promise<FredReleaseDate[]> {
  const url = new URL(PUBLIC_ENDPOINT);
  url.searchParams.set("ob", "rd");
  url.searchParams.set("vs", from);
  url.searchParams.set("ve", to);
  const html = await fetchText(SOURCE_ID, fetcher, url.toString(), timeoutMs, {
    headers: { "User-Agent": "Mozilla/5.0 stock-info-macro/0.1", "Accept-Language": "en-US,en;q=0.8" },
  });
  const token = /<span style="font-weight: bold;">([^<]+)<\/span>|<a href="\/release\?rid=(\d+)">([\s\S]*?)<\/a>/g;
  const rows: FredReleaseDate[] = [];
  let currentDate = "";
  for (const match of html.matchAll(token)) {
    if (match[1]) {
      const parsed = Date.parse(`${decodeHtml(match[1]).trim()} 12:00:00 UTC`);
      currentDate = Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
      continue;
    }
    if (!currentDate || !match[2] || !match[3]) continue;
    rows.push({ releaseId: Number(match[2]), name: decodeHtml(match[3]).replace(/<[^>]+>/g, "").trim(), date: currentDate, sourceUrl: url.toString() });
  }
  if (rows.length === 0) throw new MacroSourceError(SOURCE_ID, "invalid_response", "FRED public calendar contains no release rows", false);
  return rows;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replaceAll("&#039;", "'")
    .replaceAll("&quot;", "\"")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}
