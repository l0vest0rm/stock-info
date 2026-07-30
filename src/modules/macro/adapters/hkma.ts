import { MacroSourceError } from "./errors";
import { fetchJson, finiteNumber, recordArray } from "./http";
import type { MacroAdapterResult, MacroFetch, MacroSourceAdapter } from "./types";

const SOURCE_ID = "hkma";
const API_ROOT = "https://api.hkma.gov.hk/public";

export type HkmaField = { field: string; id: string; name: string; unit: string | null };
export type HkmaRequest = {
  dataset: string;
  fields: HkmaField[];
  frequency?: string;
  offset?: number;
};

export class HkmaOpenApiAdapter implements MacroSourceAdapter<HkmaRequest> {
  readonly sourceId = SOURCE_ID;

  constructor(private readonly fetcher: MacroFetch = fetch, private readonly timeoutMs = 7_000) {}

  async load(request: HkmaRequest): Promise<MacroAdapterResult> {
    if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(request.dataset) || request.fields.length === 0) {
      throw new MacroSourceError(SOURCE_ID, "invalid_request", "HKMA requires a valid dataset and at least one field", false);
    }
    const url = new URL(`${API_ROOT}/${request.dataset}`);
    url.searchParams.set("lang", "en");
    url.searchParams.set("offset", String(request.offset ?? 0));
    const sourceUrl = url.toString();
    const payload = await fetchJson(SOURCE_ID, this.fetcher, sourceUrl, this.timeoutMs);
    const root = asRecord(payload);
    const result = asRecord(root?.result);
    const rows = recordArray(result?.records);
    if (!rows) throw new MacroSourceError(SOURCE_ID, "invalid_response", "HKMA response is missing result.records", false);

    const observations = rows.flatMap((row) => {
      const observedAt = readDate(row);
      if (!observedAt) return [];
      return request.fields.flatMap((field) => {
        const value = finiteNumber(row[field.field]);
        return value === null ? [] : [{
          seriesId: field.id,
          value,
          observedAt,
          releasedAt: readString(row.release_date ?? row.last_updated),
          vintage: readString(row.revision ?? row.version),
          sourceUrl,
        }];
      });
    }).sort((a, b) => a.observedAt.localeCompare(b.observedAt));

    return {
      series: request.fields.map((field) => ({
        id: field.id,
        sourceId: SOURCE_ID,
        sourceSeriesId: `${request.dataset}:${field.field}`,
        name: field.name,
        frequency: request.frequency ?? "daily",
        unit: field.unit,
        sourceUrl,
      })),
      observations,
      health: { sourceId: SOURCE_ID, state: "healthy", checkedAt: new Date().toISOString(), observationCount: observations.length, message: null },
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readDate(row: Record<string, unknown>): string | null {
  return readString(row.end_of_day ?? row.end_of_date ?? row.end_of_month ?? row.date ?? row.reference_date);
}
