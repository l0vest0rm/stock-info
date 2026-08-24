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

test("source registration uses the registered BLS series rather than a metric or country lookup", () => {
  const mapping = resolveRegisteredMacroSourceMapping({
    id: 902, sourceId: "bls", sourceSeriesId: "LNS14000000",
    publicationTimestampStrategy: "bls_release_calendar", sourceBatchKey: "us-labor",
  });
  assert.deepEqual(mapping, {
    sourceId: "bls",
    sourceSeriesId: "LNS14000000",
    publicationTimestampStrategy: "bls_release_calendar",
    sourceBatchKey: "us-labor",
    blsReleaseFamily: "employment",
  });
});

for (const [name, indicator, code] of [
  ["missing mapping", { id: 5, sourceId: "fred", sourceSeriesId: null, publicationTimestampStrategy: null, sourceBatchKey: null }, "unmapped_source"],
  ["unknown provider", { id: 6, sourceId: "dbnomics", sourceSeriesId: "abc", publicationTimestampStrategy: "published_at", sourceBatchKey: "eu" }, "unsupported_source"],
  ["unverified BLS release family", { id: 7, sourceId: "bls", sourceSeriesId: "CUUR0000SA0", publicationTimestampStrategy: "bls_release_calendar", sourceBatchKey: "us-prices" }, "unsupported_release_calendar"],
]) {
  test(`source registration rejects ${name} visibly`, () => {
    assert.throws(
      () => resolveRegisteredMacroSourceMapping(indicator),
      (error) => error instanceof MacroSourceRegistrationError && error.code === code,
    );
  });
}
