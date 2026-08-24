/**
 * Source registration rules for concrete macro series already present in the
 * catalog. This module intentionally contains no regions, categories,
 * metrics, indicator IDs, or seed rows: those are operational data in
 * `macro_indicators`, not a second runtime-owned catalog.
 */

export type MacroPublicationTimestampStrategy = "fred_realtime_start" | "bls_release_calendar";
export type MacroScheduledSourceId = "fred" | "bls";
export type BlsReleaseFamily = "employment" | "jolts" | "ppi";

export type RegisteredMacroSourceMapping = {
  sourceId: MacroScheduledSourceId;
  sourceSeriesId: string;
  publicationTimestampStrategy: MacroPublicationTimestampStrategy;
  sourceBatchKey: string;
  blsReleaseFamily?: BlsReleaseFamily;
};

export type MacroDirectorySourceFields = {
  id: number;
  sourceId: string | null;
  sourceSeriesId: string | null;
  publicationTimestampStrategy: string | null;
  sourceBatchKey: string | null;
};

/** A configuration error is persisted against the leased concrete series. */
export class MacroSourceRegistrationError extends Error {
  readonly code: "unmapped_source" | "unsupported_source" | "invalid_source_series" | "unsupported_release_calendar";

  constructor(code: "unmapped_source" | "unsupported_source" | "invalid_source_series" | "unsupported_release_calendar", message: string) {
    super(message);
    this.name = "MacroSourceRegistrationError";
    this.code = code;
  }
}

/**
 * Resolves a source contract from a registered catalog row only. A new
 * region/category/metric needs no code path here; adding a new provider is an
 * explicit adapter task and fails visibly until that adapter is registered.
 */
export function resolveRegisteredMacroSourceMapping(indicator: MacroDirectorySourceFields): RegisteredMacroSourceMapping {
  const sourceId = indicator.sourceId?.trim();
  const sourceSeriesId = indicator.sourceSeriesId?.trim();
  const publicationTimestampStrategy = indicator.publicationTimestampStrategy?.trim();
  const sourceBatchKey = indicator.sourceBatchKey?.trim();
  if (!sourceId || !sourceSeriesId || !publicationTimestampStrategy || !sourceBatchKey) {
    throw new MacroSourceRegistrationError(
      "unmapped_source",
      `macro indicator ${indicator.id} has no complete source mapping`,
    );
  }
  if (sourceId === "fred") {
    if (!/^[A-Za-z0-9._-]+$/.test(sourceSeriesId)) {
      throw new MacroSourceRegistrationError("invalid_source_series", `macro indicator ${indicator.id} has an invalid FRED source series id`);
    }
    if (publicationTimestampStrategy !== "fred_realtime_start") {
      throw new MacroSourceRegistrationError("unsupported_release_calendar", `macro indicator ${indicator.id} has an unsupported FRED publication timestamp strategy`);
    }
    return { sourceId, sourceSeriesId, publicationTimestampStrategy, sourceBatchKey };
  }
  if (sourceId === "bls") {
    if (!/^[A-Z0-9]+$/.test(sourceSeriesId)) {
      throw new MacroSourceRegistrationError("invalid_source_series", `macro indicator ${indicator.id} has an invalid BLS source series id`);
    }
    const blsReleaseFamily = resolveBlsReleaseFamily(sourceSeriesId);
    if (!blsReleaseFamily) {
      throw new MacroSourceRegistrationError(
        "unsupported_release_calendar",
        `macro indicator ${indicator.id} uses BLS series ${sourceSeriesId} without a verified release-calendar family`,
      );
    }
    if (publicationTimestampStrategy !== "bls_release_calendar") {
      throw new MacroSourceRegistrationError("unsupported_release_calendar", `macro indicator ${indicator.id} has an unsupported BLS publication timestamp strategy`);
    }
    return { sourceId, sourceSeriesId, publicationTimestampStrategy, sourceBatchKey, blsReleaseFamily };
  }
  throw new MacroSourceRegistrationError("unsupported_source", `macro indicator ${indicator.id} uses unsupported scheduled source: ${sourceId}`);
}

function resolveBlsReleaseFamily(seriesId: string): BlsReleaseFamily | null {
  if (seriesId.startsWith("LNS")) return "employment";
  if (seriesId.startsWith("JTS")) return "jolts";
  if (seriesId.startsWith("WPU")) return "ppi";
  return null;
}
