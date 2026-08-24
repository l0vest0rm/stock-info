import { BlsPublicDataAdapter, FredAdapter, loadBlsReleaseCalendar } from "./index";
import type { MacroFetch } from "./types";

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function jsonFetch(body: unknown, inspect?: (url: string, init?: RequestInit) => void): MacroFetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    inspect?.(String(input), init);
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as MacroFetch;
}

function textFetch(body: string): MacroFetch {
  return (async () => new Response(body, { status: 200, headers: { "Content-Type": "text/html" } })) as MacroFetch;
}

async function testFred(): Promise<void> {
  let requested = "";
  const adapter = new FredAdapter("secret-key", jsonFetch({ observations: [{ realtime_start: "2026-07-01", realtime_end: "2026-07-29", date: "2026-06-01", value: "3.2" }] }, (url) => { requested = url; }));
  const result = await adapter.load({ seriesId: "indicator-1", sourceSeriesId: "UNRATE", name: "Unemployment rate", frequency: "monthly", unit: "%" });
  equal(requested.includes("api_key=secret-key"), true, "FRED authenticated request");
  equal(result.observations[0].seriesId, "UNRATE", "FRED observations retain the provider series id for catalog persistence");
  equal(result.observations[0].releasedAt, "2026-07-01", "FRED realtime start is retained");
  equal(result.observations[0].sourceUrl.includes("secret-key"), false, "FRED public URL redaction");
}

async function testBls(): Promise<void> {
  let method = "";
  const fetcher = jsonFetch({ status: "REQUEST_SUCCEEDED", Results: { series: [{ seriesID: "LNS14000000", data: [{ year: "2026", period: "M06", value: "4.2", latest: "true" }] }] } }, (_url, init) => { method = init?.method ?? ""; });
  const result = await new BlsPublicDataAdapter(fetcher).load({ series: [{ id: "LNS14000000", name: "Unemployment Rate", unit: "%" }], startYear: 2026, endYear: 2026 });
  equal(method, "POST", "BLS method");
  equal(result.observations[0].observedAt, "2026-06", "BLS monthly date");
  equal(result.observations[0].releasedAt, null, "BLS does not invent row release timestamps");
}

async function testBlsReleaseCalendar(): Promise<void> {
  const calendar = await loadBlsReleaseCalendar(textFetch(`
    <table><tr><td>Employment Situation</td><td>August 7, 2026</td></tr>
    <tr><td>Job Openings and Labor Turnover Survey</td><td>August 4, 2026</td></tr>
    <tr><td>Producer Price Index</td><td>08/13/2026</td></tr></table>
  `), 1_800_000_000);
  equal(calendar.get("employment"), 1786104000, "employment release date");
  equal(calendar.get("jolts"), 1785844800, "JOLTS release date");
  equal(calendar.get("ppi"), 1786622400, "PPI release date");
}

await testFred();
await testBls();
await testBlsReleaseCalendar();
console.log("macro adapter tests passed");
