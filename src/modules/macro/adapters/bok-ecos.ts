import { MacroSourceError, requireCredential } from "./errors";
import { fetchJson, finiteNumber, recordArray } from "./http";
import type { MacroAdapterResult, MacroFetch, MacroSourceAdapter } from "./types";

const SOURCE_ID = "bok-ecos";
const API_ROOT = "https://ecos.bok.or.kr/api/StatisticSearch";

export type BokEcosRequest = {
  statCode: string;
  itemCode: string;
  cycle: "A" | "S" | "Q" | "M" | "SM" | "D";
  start: string;
  end: string;
  name?: string;
  language?: "en" | "kr";
  limit?: number;
};

export class BokEcosAdapter implements MacroSourceAdapter<BokEcosRequest> {
  readonly sourceId = SOURCE_ID;

  constructor(private readonly apiKey: string | undefined, private readonly fetcher: MacroFetch = fetch, private readonly timeoutMs = 7_000) {}

  async load(request: BokEcosRequest): Promise<MacroAdapterResult> {
    const apiKey = requireCredential(SOURCE_ID, this.apiKey, "BOK_ECOS_API_KEY");
    for (const value of [request.statCode, request.itemCode, request.start, request.end]) {
      if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new MacroSourceError(SOURCE_ID, "invalid_request", "Invalid BOK ECOS request segment", false);
    }
    const limit = Math.min(Math.max(request.limit ?? 1_000, 1), 100_000);
    const segments = [apiKey, "json", request.language ?? "en", "1", String(limit), request.statCode, request.cycle, request.start, request.end, request.itemCode];
    const requestUrl = `${API_ROOT}/${segments.map(encodeURIComponent).join("/")}`;
    const publicSourceUrl = requestUrl.replace(encodeURIComponent(apiKey), "REDACTED");
    const payload = await fetchJson(SOURCE_ID, this.fetcher, requestUrl, this.timeoutMs);
    const root = asRecord(payload);
    const result = asRecord(root?.StatisticSearch);
    const rows = recordArray(result?.row);
    if (!rows) throw new MacroSourceError(SOURCE_ID, "invalid_response", ecosError(root) ?? "BOK ECOS response is missing StatisticSearch.row", false);
    const seriesId = `ECOS:${request.statCode}:${request.itemCode}`;
    const observations = rows.flatMap((row) => {
      const observedAt = normalizePeriod(text(row.TIME), request.cycle);
      const value = finiteNumber(row.DATA_VALUE);
      return observedAt && value !== null ? [{ seriesId, value, observedAt, releasedAt: text(row.RELEASE_DATE), vintage: text(row.VERSION), sourceUrl: publicSourceUrl }] : [];
    });
    const first = rows[0];
    return {
      series: [{ id: seriesId, sourceId: SOURCE_ID, sourceSeriesId: `${request.statCode}:${request.itemCode}`, name: request.name ?? text(first?.STAT_NAME) ?? seriesId, frequency: cycleName(request.cycle), unit: text(first?.UNIT_NAME), sourceUrl: publicSourceUrl }],
      observations,
      health: { sourceId: SOURCE_ID, state: "healthy", checkedAt: new Date().toISOString(), observationCount: observations.length, message: null },
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" ? value as Record<string, unknown> : null; }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function ecosError(root: Record<string, unknown> | null): string | null {
  const error = asRecord(root?.RESULT);
  return text(error?.MESSAGE);
}
function normalizePeriod(value: string | null, cycle: BokEcosRequest["cycle"]): string | null {
  if (!value) return null;
  if (cycle === "D" && /^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if ((cycle === "M" || cycle === "SM") && /^\d{6}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}`;
  if (/^\d{4}$/.test(value)) return value;
  return value;
}
function cycleName(cycle: BokEcosRequest["cycle"]): string {
  return ({ A: "annual", S: "semiannual", Q: "quarterly", M: "monthly", SM: "semimonthly", D: "daily" } as const)[cycle];
}
