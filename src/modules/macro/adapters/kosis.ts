import { MacroSourceError, requireCredential } from "./errors";
import { fetchJson, finiteNumber, recordArray } from "./http";
import type { MacroAdapterResult, MacroFetch, MacroSourceAdapter } from "./types";

const SOURCE_ID = "kosis";
const ENDPOINT = "https://kosis.kr/openapi/Param/statisticsParameterData.do";

export type KosisRequest = {
  orgId: string;
  tableId: string;
  itemId: string;
  period: "Y" | "H" | "Q" | "M" | "D";
  start: string;
  end: string;
  name?: string;
  objectSelections?: Record<string, string>;
};

export class KosisAdapter implements MacroSourceAdapter<KosisRequest> {
  readonly sourceId = SOURCE_ID;

  constructor(private readonly apiKey: string | undefined, private readonly fetcher: MacroFetch = fetch, private readonly timeoutMs = 7_000) {}

  async load(request: KosisRequest): Promise<MacroAdapterResult> {
    const apiKey = requireCredential(SOURCE_ID, this.apiKey, "KOSIS_API_KEY");
    const url = new URL(ENDPOINT);
    const params: Record<string, string> = {
      method: "getList", apiKey, itmId: request.itemId, format: "json", jsonVD: "Y",
      prdSe: request.period, startPrdDe: request.start, endPrdDe: request.end,
      orgId: request.orgId, tblId: request.tableId, ...request.objectSelections,
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const requestUrl = url.toString();
    const publicSourceUrl = redactApiKey(requestUrl);
    const payload = await fetchJson(SOURCE_ID, this.fetcher, requestUrl, this.timeoutMs);
    const rows = recordArray(payload);
    if (!rows) throw new MacroSourceError(SOURCE_ID, "invalid_response", kosisError(payload) ?? "KOSIS response is not an array", false);
    const seriesId = `KOSIS:${request.orgId}:${request.tableId}:${request.itemId}`;
    const observations = rows.flatMap((row) => {
      const observedAt = text(row.PRD_DE);
      const value = finiteNumber(row.DT);
      return observedAt && value !== null ? [{ seriesId, value, observedAt, releasedAt: text(row.RELEASE_DATE), vintage: text(row.C1_NM), sourceUrl: publicSourceUrl }] : [];
    });
    const first = rows[0];
    return {
      series: [{ id: seriesId, sourceId: SOURCE_ID, sourceSeriesId: `${request.orgId}:${request.tableId}:${request.itemId}`, name: request.name ?? text(first?.ITM_NM) ?? seriesId, frequency: periodName(request.period), unit: text(first?.UNIT_NM), sourceUrl: publicSourceUrl }],
      observations,
      health: { sourceId: SOURCE_ID, state: "healthy", checkedAt: new Date().toISOString(), observationCount: observations.length, message: null },
    };
  }
}

function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function kosisError(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const root = value as Record<string, unknown>;
  return text(root.errMsg ?? root.message);
}
function redactApiKey(url: string): string { const safe = new URL(url); safe.searchParams.delete("apiKey"); return safe.toString(); }
function periodName(period: KosisRequest["period"]): string { return ({ Y: "annual", H: "semiannual", Q: "quarterly", M: "monthly", D: "daily" } as const)[period]; }
