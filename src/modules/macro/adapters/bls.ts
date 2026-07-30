import { MacroSourceError } from "./errors";
import { fetchJson, finiteNumber, recordArray } from "./http";
import type { MacroAdapterResult, MacroFetch, MacroSourceAdapter } from "./types";

const SOURCE_ID = "bls";
const ENDPOINT = "https://api.bls.gov/publicAPI/v2/timeseries/data/";

export type BlsSeriesRequest = { id: string; name: string; unit: string | null; frequency?: string };
export type BlsRequest = { series: BlsSeriesRequest[]; startYear: number; endYear: number; registrationKey?: string };

export class BlsPublicDataAdapter implements MacroSourceAdapter<BlsRequest> {
  readonly sourceId = SOURCE_ID;

  constructor(private readonly fetcher: MacroFetch = fetch, private readonly timeoutMs = 7_000) {}

  async load(request: BlsRequest): Promise<MacroAdapterResult> {
    const maxSeries = request.registrationKey ? 50 : 25;
    if (request.series.length === 0 || request.series.length > maxSeries || request.startYear > request.endYear) {
      throw new MacroSourceError(SOURCE_ID, "invalid_request", `BLS requires 1-${maxSeries} series and a valid year range`, false);
    }
    const body: Record<string, unknown> = { seriesid: request.series.map((item) => item.id), startyear: String(request.startYear), endyear: String(request.endYear) };
    if (request.registrationKey?.trim()) body.registrationkey = request.registrationKey.trim();
    const payload = await fetchJson(SOURCE_ID, this.fetcher, ENDPOINT, this.timeoutMs, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const root = asRecord(payload);
    if (root?.status !== "REQUEST_SUCCEEDED") {
      throw new MacroSourceError(SOURCE_ID, "invalid_response", `BLS request failed: ${messages(root).join("; ") || "unknown response"}`, false);
    }
    const results = asRecord(root.Results);
    const returnedSeries = recordArray(results?.series);
    if (!returnedSeries) throw new MacroSourceError(SOURCE_ID, "invalid_response", "BLS response is missing Results.series", false);
    const observations = returnedSeries.flatMap((sourceSeries) => {
      const seriesId = text(sourceSeries.seriesID);
      const rows = recordArray(sourceSeries.data);
      if (!seriesId || !rows) return [];
      return rows.flatMap((row) => {
        const observedAt = periodDate(text(row.year), text(row.period));
        const value = finiteNumber(row.value);
        return observedAt && value !== null ? [{
          seriesId,
          value,
          observedAt,
          releasedAt: null,
          vintage: row.latest === "true" ? "latest" : null,
          sourceUrl: ENDPOINT,
        }] : [];
      });
    }).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    return {
      series: request.series.map((item) => ({ id: item.id, sourceId: SOURCE_ID, sourceSeriesId: item.id, name: item.name, frequency: item.frequency ?? "monthly", unit: item.unit, sourceUrl: ENDPOINT })),
      observations,
      health: { sourceId: SOURCE_ID, state: "healthy", checkedAt: new Date().toISOString(), observationCount: observations.length, message: null },
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" ? value as Record<string, unknown> : null; }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function messages(root: Record<string, unknown> | null): string[] { return Array.isArray(root?.message) ? root.message.filter((item): item is string => typeof item === "string") : []; }
function periodDate(year: string | null, period: string | null): string | null {
  if (!year || !period) return null;
  const monthly = /^M(0[1-9]|1[0-2])$/.exec(period);
  if (monthly) return `${year}-${monthly[1]}`;
  const quarterly = /^Q0?([1-4])$/.exec(period);
  if (quarterly) return `${year}-Q${quarterly[1]}`;
  return null;
}
