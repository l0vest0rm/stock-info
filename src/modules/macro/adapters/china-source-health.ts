import type { MacroSourceHealth } from "./types";

export function unsupportedChinaSourceHealth(checkedAt = new Date().toISOString()): MacroSourceHealth[] {
  return [
    {
      sourceId: "nbs-cn",
      state: "unsupported",
      checkedAt,
      observationCount: 0,
      message: "NBS adapter is not configured: an official stable structured endpoint and request contract must be verified before ingestion.",
    },
    {
      sourceId: "pboc",
      state: "unsupported",
      checkedAt,
      observationCount: 0,
      message: "PBOC adapter is not configured: heterogeneous official releases require a verified series-specific ingestion contract.",
    },
  ];
}
