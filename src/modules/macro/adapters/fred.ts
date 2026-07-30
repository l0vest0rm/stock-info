import { MacroSourceError } from "./errors";
import { fetchJson, fetchText, finiteNumber, recordArray } from "./http";
import type { MacroAdapterResult, MacroFetch, MacroSourceAdapter } from "./types";

const SOURCE_ID = "fred";
const ENDPOINT = "https://api.stlouisfed.org/fred/series/observations";
const PUBLIC_CSV_ENDPOINT = "https://fred.stlouisfed.org/graph/fredgraph.csv";

export type FredRequest = {
  seriesId: string;
  sourceSeriesId?: string;
  name: string;
  frequency: string;
  unit: string | null;
  observationStart?: string;
  observationEnd?: string;
};

export class FredAdapter implements MacroSourceAdapter<FredRequest> {
  readonly sourceId = SOURCE_ID;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetcher: MacroFetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  async load(request: FredRequest): Promise<MacroAdapterResult> {
    if (!/^[A-Za-z0-9._-]+$/.test(request.seriesId)) {
      throw new MacroSourceError(SOURCE_ID, "invalid_request", "Invalid FRED series id", false);
    }
    return this.apiKey?.trim() ? this.loadApi(request, this.apiKey.trim()) : this.loadPublicCsv(request);
  }

  private async loadApi(request: FredRequest, apiKey: string): Promise<MacroAdapterResult> {
    const sourceSeriesId = request.sourceSeriesId ?? request.seriesId;
    const url = new URL(ENDPOINT);
    url.searchParams.set("series_id", sourceSeriesId);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("file_type", "json");
    if (request.observationStart) url.searchParams.set("observation_start", request.observationStart);
    if (request.observationEnd) url.searchParams.set("observation_end", request.observationEnd);
    const requestUrl = url.toString();
    const publicSourceUrl = redactApiKey(requestUrl);
    const payload = await fetchJson(SOURCE_ID, this.fetcher, requestUrl, this.timeoutMs);
    const root = asRecord(payload);
    const rows = recordArray(root?.observations);
    if (!rows) throw new MacroSourceError(SOURCE_ID, "invalid_response", "FRED response is missing observations", false);
    const observations = rows.flatMap((row) => {
      const observedAt = text(row.date);
      const value = finiteNumber(row.value);
      if (!observedAt || value === null) return [];
      return [{
        seriesId: request.seriesId,
        value,
        observedAt,
        releasedAt: text(row.realtime_start),
        vintage: vintage(row),
        sourceUrl: publicSourceUrl,
      }];
    });
    return {
      series: [{ id: request.seriesId, sourceId: SOURCE_ID, sourceSeriesId, name: request.name, frequency: request.frequency, unit: request.unit, sourceUrl: publicSourceUrl }],
      observations,
      health: { sourceId: SOURCE_ID, state: "healthy", checkedAt: new Date().toISOString(), observationCount: observations.length, message: null },
    };
  }

  private async loadPublicCsv(request: FredRequest): Promise<MacroAdapterResult> {
    const sourceSeriesId = request.sourceSeriesId ?? request.seriesId;
    const url = new URL(PUBLIC_CSV_ENDPOINT);
    url.searchParams.set("id", sourceSeriesId);
    if (request.observationStart) url.searchParams.set("cosd", request.observationStart);
    if (request.observationEnd) url.searchParams.set("coed", request.observationEnd);
    const sourceUrl = url.toString();
    const csv = await fetchText(SOURCE_ID, this.fetcher, sourceUrl, this.timeoutMs, {
      headers: { "User-Agent": "Mozilla/5.0 stock-info-macro/0.1", "Accept-Language": "en-US,en;q=0.8" },
    });
    const lines = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    const header = lines.shift()?.split(",").map((item) => item.trim()) ?? [];
    if (header[0] !== "observation_date" || header[1] !== sourceSeriesId) {
      throw new MacroSourceError(SOURCE_ID, "invalid_response", "FRED CSV response has an unexpected header", false);
    }
    const observations = lines.flatMap((line) => {
      const separator = line.indexOf(",");
      if (separator < 0) return [];
      const observedAt = line.slice(0, separator).trim();
      const value = finiteNumber(line.slice(separator + 1));
      return /^\d{4}-\d{2}-\d{2}$/.test(observedAt) && value !== null ? [{
        seriesId: request.seriesId,
        value,
        observedAt,
        releasedAt: null,
        vintage: null,
        sourceUrl,
      }] : [];
    });
    return {
      series: [{ id: request.seriesId, sourceId: SOURCE_ID, sourceSeriesId, name: request.name, frequency: request.frequency, unit: request.unit, sourceUrl }],
      observations,
      health: { sourceId: SOURCE_ID, state: "healthy", checkedAt: new Date().toISOString(), observationCount: observations.length, message: "official public CSV" },
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function vintage(row: Record<string, unknown>): string | null {
  const start = text(row.realtime_start);
  const end = text(row.realtime_end);
  return start && end ? `${start}/${end}` : start ?? end;
}
function redactApiKey(url: string): string {
  const safe = new URL(url);
  safe.searchParams.delete("api_key");
  return safe.toString();
}
