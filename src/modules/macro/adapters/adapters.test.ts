import { BokEcosAdapter } from "./bok-ecos";
import { BlsPublicDataAdapter } from "./bls";
import { unsupportedChinaSourceHealth } from "./china-source-health";
import { FredAdapter } from "./fred";
import { loadFredReleaseCalendar } from "./fred-calendar";
import { HkmaOpenApiAdapter } from "./hkma";
import { KosisAdapter } from "./kosis";
import { NyFedSofrAdapter } from "./ny-fed-sofr";
import type { MacroFetch } from "./types";

function jsonFetch(body: unknown, inspect?: (url: string) => void): MacroFetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    inspect?.(url);
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as MacroFetch;
}

function textFetch(body: string, inspect?: (url: string) => void): MacroFetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    inspect?.(url);
    return new Response(body, { status: 200, headers: { "Content-Type": "text/plain" } });
  }) as MacroFetch;
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

async function testNyFed(): Promise<void> {
  const adapter = new NyFedSofrAdapter(jsonFetch({ refRates: [{ effectiveDate: "2026-07-28", percentRate: "4.36", lastUpdated: "2026-07-29T12:00:00Z", revisionIndicator: "" }] }));
  const result = await adapter.load({ startDate: "2026-07-01", endDate: "2026-07-29" });
  equal(result.observations[0].value, 4.36, "NY Fed value");
  equal(result.observations[0].releasedAt, "2026-07-29T12:00:00.000Z", "NY Fed release timestamp");
  equal(result.health.observationCount, 1, "NY Fed health count");
}

async function testHkma(): Promise<void> {
  const adapter = new HkmaOpenApiAdapter(jsonFetch({ result: { records: [{ end_of_date: "2026-07-28", base_rate: "4.75", version: "revised" }] } }));
  const result = await adapter.load({ dataset: "market-data-and-statistics/daily-monetary-statistics/example", fields: [{ field: "base_rate", id: "HKMA_BASE_RATE", name: "Base Rate", unit: "%" }] });
  equal(result.observations[0].observedAt, "2026-07-28", "HKMA observed date");
  equal(result.observations[0].vintage, "revised", "HKMA vintage");
}

async function testFred(): Promise<void> {
  let requested = "";
  const adapter = new FredAdapter("secret-key", jsonFetch({ observations: [{ realtime_start: "2026-07-01", realtime_end: "2026-07-29", date: "2026-06-01", value: "3.2" }] }, (url) => { requested = url; }));
  const result = await adapter.load({ seriesId: "UNRATE", name: "Unemployment Rate", frequency: "monthly", unit: "%" });
  equal(requested.includes("api_key=secret-key"), true, "FRED authenticated request");
  equal(result.observations[0].sourceUrl.includes("secret-key"), false, "FRED public URL redaction");
  equal(result.observations[0].vintage, "2026-07-01/2026-07-29", "FRED vintage");
}

async function testFredCalendar(): Promise<void> {
  const rows = await loadFredReleaseCalendar("secret-key", "2026-07-01", "2026-07-31", jsonFetch({ release_dates: [{ release_id: 10, release_name: "Consumer Price Index", date: "2026-07-14" }] }));
  equal(rows[0].name, "Consumer Price Index", "FRED calendar name");
  equal(rows[0].sourceUrl.includes("secret-key"), false, "FRED calendar key redaction");
}

async function testBok(): Promise<void> {
  const adapter = new BokEcosAdapter("ecos-key", jsonFetch({ StatisticSearch: { row: [{ STAT_NAME: "Base Rate", UNIT_NAME: "%", TIME: "20260728", DATA_VALUE: "2.50", RELEASE_DATE: "2026-07-29" }] } }));
  const result = await adapter.load({ statCode: "722Y001", itemCode: "0101000", cycle: "D", start: "20260701", end: "20260729" });
  equal(result.observations[0].observedAt, "2026-07-28", "ECOS daily date normalization");
  equal(result.observations[0].releasedAt, "2026-07-29", "ECOS release date");
  equal(result.observations[0].sourceUrl.includes("ecos-key"), false, "ECOS key redaction");
}

async function testKosis(): Promise<void> {
  const adapter = new KosisAdapter("kosis-key", jsonFetch([{ PRD_DE: "202606", DT: "101.7", ITM_NM: "CPI", UNIT_NM: "2020=100", RELEASE_DATE: "2026-07-02" }]));
  const result = await adapter.load({ orgId: "101", tableId: "DT_1J22003", itemId: "T10", period: "M", start: "202601", end: "202606" });
  equal(result.series[0].name, "CPI", "KOSIS metadata");
  equal(result.observations[0].value, 101.7, "KOSIS value");
  equal(result.observations[0].sourceUrl.includes("kosis-key"), false, "KOSIS key redaction");
}

async function testFredPublicCsv(): Promise<void> {
  let requested = "";
  const result = await new FredAdapter(undefined, textFetch("observation_date,UNRATE\n2026-05-01,4.2\n2026-06-01,.\n", (url) => { requested = url; }))
    .load({ seriesId: "UNRATE", name: "Unemployment Rate", frequency: "monthly", unit: "%", observationStart: "2026-01-01" });
  equal(requested.includes("fredgraph.csv"), true, "FRED public CSV request");
  equal(result.observations.length, 1, "FRED CSV missing value filtering");
  equal(result.observations[0].value, 4.2, "FRED CSV value");
}

async function testFredPublicCalendar(): Promise<void> {
  const html = '<span style="font-weight: bold;">Tuesday July 14, 2026</span><a href="/release?rid=10">Consumer Price Index</a>';
  const rows = await loadFredReleaseCalendar(undefined, "2026-07-01", "2026-07-31", textFetch(html));
  equal(rows[0].date, "2026-07-14", "FRED public calendar date");
  equal(rows[0].name, "Consumer Price Index", "FRED public calendar name");
}

async function testBls(): Promise<void> {
  let method = "";
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    method = init?.method ?? "GET";
    return new Response(JSON.stringify({ status: "REQUEST_SUCCEEDED", Results: { series: [{ seriesID: "LNS14000000", data: [{ year: "2026", period: "M06", value: "4.1", latest: "true" }] }] } }), { status: 200 });
  }) as MacroFetch;
  const result = await new BlsPublicDataAdapter(fetcher).load({ series: [{ id: "LNS14000000", name: "Unemployment Rate", unit: "%" }], startYear: 2026, endYear: 2026 });
  equal(method, "POST", "BLS method");
  equal(result.observations[0].observedAt, "2026-06", "BLS monthly date");
  equal(result.observations[0].vintage, "latest", "BLS vintage marker");
  equal(unsupportedChinaSourceHealth()[0].state, "unsupported", "NBS explicit state");
}

await testNyFed();
await testHkma();
await testFred();
await testFredCalendar();
await testBok();
await testKosis();
await testFredPublicCsv();
await testFredPublicCalendar();
await testBls();
console.log("macro adapter tests passed");
