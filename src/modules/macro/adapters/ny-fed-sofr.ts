import { MacroSourceError } from "./errors";
import { fetchJson, finiteNumber, recordArray } from "./http";
import type { MacroAdapterResult, MacroFetch, MacroSourceAdapter } from "./types";

const SOURCE_ID = "ny-fed";
const ENDPOINT = "https://markets.newyorkfed.org/api/rates/secured/sofr/search.json";

export type NyFedSofrRequest = { startDate: string; endDate: string };

export class NyFedSofrAdapter implements MacroSourceAdapter<NyFedSofrRequest> {
  readonly sourceId = SOURCE_ID;

  constructor(private readonly fetcher: MacroFetch = fetch, private readonly timeoutMs = 7_000) {}

  async load(request: NyFedSofrRequest): Promise<MacroAdapterResult> {
    assertDateRange(request.startDate, request.endDate);
    const url = new URL(ENDPOINT);
    url.searchParams.set("startDate", request.startDate);
    url.searchParams.set("endDate", request.endDate);
    url.searchParams.set("type", "rate");
    const sourceUrl = url.toString();
    const payload = await fetchJson(SOURCE_ID, this.fetcher, sourceUrl, this.timeoutMs);
    const root = asRecord(payload);
    const rows = recordArray(root?.refRates);
    if (!rows) throw new MacroSourceError(SOURCE_ID, "invalid_response", "NY Fed response is missing refRates", false);

    const observations = rows.flatMap((row) => {
      const observedAt = stringValue(row.effectiveDate);
      const value = finiteNumber(row.percentRate);
      if (!observedAt || value === null) return [];
      return [{
        seriesId: "SOFR",
        value,
        observedAt,
        releasedAt: normalizeTimestamp(row.lastUpdated ?? row.releaseDate),
        vintage: stringValue(row.revisionIndicator),
        sourceUrl,
      }];
    }).sort((a, b) => a.observedAt.localeCompare(b.observedAt));

    return {
      series: [{ id: "SOFR", sourceId: SOURCE_ID, sourceSeriesId: "SOFR", name: "Secured Overnight Financing Rate", frequency: "daily", unit: "%", sourceUrl }],
      observations,
      health: { sourceId: SOURCE_ID, state: "healthy", checkedAt: new Date().toISOString(), observationCount: observations.length, message: null },
    };
  }
}

function assertDateRange(start: string, end: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
    throw new MacroSourceError(SOURCE_ID, "invalid_request", "NY Fed requires a valid startDate/endDate range", false);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTimestamp(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : raw;
}
