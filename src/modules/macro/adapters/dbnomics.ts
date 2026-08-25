import { MacroSourceError } from "./errors";
import { fetchJson, finiteNumber, recordArray } from "./http";
import type { MacroAdapterResult, MacroFetch, MacroSourceAdapter } from "./types";

const SOURCE_ID = "dbnomics";
const ENDPOINT = "https://api.db.nomics.world/v22/series";

export type DbnomicsRequest = {
  /** provider/dataset/series; each segment is URL-encoded independently. */
  sourceSeriesId: string;
  name: string;
  frequency: string;
  unit: string | null;
  /** Explicit source-family policy boundary; observations after this date are not actual macro observations. */
  observationEnd?: string;
};

/**
 * Reads one explicitly registered DBnomics series.  DBnomics exposes a
 * dataset-level `indexed_at`, but not observation-level release vintages;
 * callers must supply a separately verified publication strategy before
 * persisting these observations.
 */
export class DbnomicsAdapter implements MacroSourceAdapter<DbnomicsRequest> {
  readonly sourceId = SOURCE_ID;

  constructor(private readonly fetcher: MacroFetch = fetch, private readonly timeoutMs = 20_000) {}

  async load(request: DbnomicsRequest): Promise<MacroAdapterResult> {
    const segments = request.sourceSeriesId.split("/");
    if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9._:-]+$/.test(segment))) {
      throw new MacroSourceError(SOURCE_ID, "invalid_request", "DBnomics series must be provider/dataset/series", false);
    }
    const sourceUrl = `${ENDPOINT}/${segments.map(encodeURIComponent).join("/")}?observations=1`;
    const root = asRecord(await fetchJson(SOURCE_ID, this.fetcher, sourceUrl, this.timeoutMs));
    const series = recordArray(asRecord(root?.series)?.docs);
    const document = series?.[0];
    const periods = stringArray(document?.period_start_day);
    const values = Array.isArray(document?.value) ? document.value : null;
    if (!document || !periods || !values || periods.length !== values.length) {
      throw new MacroSourceError(SOURCE_ID, "invalid_response", "DBnomics response is missing aligned period_start_day/value observations", false);
    }
    const observations = periods.flatMap((observedAt, index) => {
      const value = finiteNumber(values[index]);
      return isoDay(observedAt) && (!request.observationEnd || observedAt <= request.observationEnd) && value !== null ? [{
        // Persistence joins with the complete catalog mapping, not the
        // provider-local series code returned by DBnomics.
        seriesId: request.sourceSeriesId,
        value,
        observedAt,
        releasedAt: null,
        vintage: null,
        sourceUrl,
      }] : [];
    });
    return {
      series: [{ id: request.sourceSeriesId, sourceId: SOURCE_ID, sourceSeriesId: request.sourceSeriesId, name: request.name, frequency: request.frequency, unit: request.unit, sourceUrl }],
      observations,
      health: { sourceId: SOURCE_ID, state: "healthy", checkedAt: new Date().toISOString(), observationCount: observations.length, message: "DBnomics observations; catalog owns the verified release batch" },
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}
function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}
function isoDay(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value); }
