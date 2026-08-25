import assert from "node:assert/strict";
import test from "node:test";
import {
  MacroSourceRegistrationError,
  resolveRegisteredMacroSourceMapping,
} from "./indicators.ts";

test("source registration resolves an arbitrary third-region concrete series from directory fields", () => {
  const mapping = resolveRegisteredMacroSourceMapping({
    id: 701,
    sourceId: "fred",
    sourceSeriesId: "KRCPIALL",
    publicationTimestampStrategy: "fred_realtime_start",
    sourceBatchKey: "korea-official-fred-mirror",
  });
  assert.deepEqual(mapping, {
    sourceId: "fred",
    sourceSeriesId: "KRCPIALL",
    publicationTimestampStrategy: "fred_realtime_start",
    sourceBatchKey: "korea-official-fred-mirror",
  });
});

test("source registration resolves only verified BLS series to their official release-calendar family", () => {
  for (const [sourceSeriesId, blsReleaseFamily] of [
    ["LNS14000000", "employment"],
    ["LNS11300000", "employment"],
    ["JTS000000000000000JOL", "jolts"],
    ["WPUFD4", "ppi"],
  ]) {
    const mapping = resolveRegisteredMacroSourceMapping({
      id: 902, sourceId: "bls", sourceSeriesId,
      publicationTimestampStrategy: "bls_release_calendar", sourceBatchKey: "us-labor",
    });
    assert.deepEqual(mapping, {
      sourceId: "bls",
      sourceSeriesId,
      publicationTimestampStrategy: "bls_release_calendar",
      sourceBatchKey: "us-labor",
      blsReleaseFamily,
    });
  }
});

test("source registration accepts DBnomics only with a catalog-owned dataset release timestamp", () => {
  const mapping = resolveRegisteredMacroSourceMapping({
    id: 1001, sourceId: "dbnomics", sourceSeriesId: "IMF/WEO:2025-04/CHN.NGDP_RPCH.pcent_change",
    publicationTimestampStrategy: "dbnomics_dataset_release", sourceBatchKey: "imf-weo-2025-04:1745323200",
  });
  assert.deepEqual(mapping, {
    sourceId: "dbnomics", sourceSeriesId: "IMF/WEO:2025-04/CHN.NGDP_RPCH.pcent_change",
    publicationTimestampStrategy: "dbnomics_dataset_release", sourceBatchKey: "imf-weo-2025-04:1745323200", datasetReleasedAt: 1745323200, observedThrough: "2024-12-31",
  });
});

for (const [name, indicator, code] of [
  ["missing mapping", { id: 5, sourceId: "fred", sourceSeriesId: null, publicationTimestampStrategy: null, sourceBatchKey: null }, "unmapped_source"],
  ["unknown provider", { id: 6, sourceId: "unknown", sourceSeriesId: "abc", publicationTimestampStrategy: "published_at", sourceBatchKey: "eu" }, "unsupported_source"],
  ["DBnomics variable snapshot", { id: 8, sourceId: "dbnomics", sourceSeriesId: "IMF/IFS/CHN.FIDR_PA", publicationTimestampStrategy: "dbnomics_dataset_release", sourceBatchKey: "imf-ifs" }, "invalid_source_series"],
  ["DBnomics unverified WEO release", { id: 9, sourceId: "dbnomics", sourceSeriesId: "IMF/WEO:2026-04/CHN.NGDP_RPCH.pcent_change", publicationTimestampStrategy: "dbnomics_dataset_release", sourceBatchKey: "imf-weo-2026-04:1776816000" }, "unsupported_release_calendar"],
  ["unverified BLS release family", { id: 7, sourceId: "bls", sourceSeriesId: "LNS12000000", publicationTimestampStrategy: "bls_release_calendar", sourceBatchKey: "us-labor" }, "unsupported_release_calendar"],
]) {
  test(`source registration rejects ${name} visibly`, () => {
    assert.throws(
      () => resolveRegisteredMacroSourceMapping(indicator),
      (error) => error instanceof MacroSourceRegistrationError && error.code === code,
    );
  });
}
