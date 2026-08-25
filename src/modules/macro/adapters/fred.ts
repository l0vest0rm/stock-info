import { MacroSourceError } from "./errors";
import { fetchJson, finiteNumber, recordArray } from "./http";
import type { MacroAdapterResult, MacroFetch, MacroSourceAdapter } from "./types";

const SOURCE_ID = "fred";
const ENDPOINT = "https://api.stlouisfed.org/fred/series/observations";

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
    const apiKey = this.apiKey?.trim();
    if (!apiKey) {
      throw new MacroSourceError(SOURCE_ID, "missing_credential", "FRED_API_KEY is required for realtime_start publication timestamps", false);
    }
    return this.loadApi(request, apiKey);
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
        // Persistence joins observations to the source catalog by the
        // provider's series identifier.  `request.seriesId` is only an
        // internal caller label and must never leak into that join.
        seriesId: sourceSeriesId,
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
