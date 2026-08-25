/**
 * Source registration rules for concrete macro series already present in the
 * catalog. This module intentionally contains no regions, categories,
 * metrics, indicator IDs, or seed rows: those are operational data in
 * `macro_indicators`, not a second runtime-owned catalog.
 */

export type MacroPublicationTimestampStrategy = "fred_realtime_start" | "bls_release_calendar" | "dbnomics_dataset_release";
export type MacroScheduledSourceId = "fred" | "bls" | "dbnomics";
export type BlsReleaseFamily = "employment" | "jolts" | "ppi";

export type RegisteredMacroSourceMapping = {
  sourceId: MacroScheduledSourceId;
  sourceSeriesId: string;
  publicationTimestampStrategy: MacroPublicationTimestampStrategy;
  sourceBatchKey: string;
  blsReleaseFamily?: BlsReleaseFamily;
  datasetReleasedAt?: number;
  observedThrough?: string;
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
  if (sourceId === "dbnomics") {
    const series = /^IMF\/(WEO:\d{4}-\d{2})\/([A-Za-z0-9._:-]+)$/.exec(sourceSeriesId);
    if (!series) {
      throw new MacroSourceRegistrationError("invalid_source_series", `macro indicator ${indicator.id} must use an explicitly released IMF WEO DBnomics dataset`);
    }
    if (publicationTimestampStrategy !== "dbnomics_dataset_release") {
      throw new MacroSourceRegistrationError("unsupported_release_calendar", `macro indicator ${indicator.id} must use a verified DBnomics dataset release timestamp`);
    }
    const release = dbnomicsWEORelease(sourceBatchKey, series[1]);
    if (release === null) {
      throw new MacroSourceRegistrationError("unsupported_release_calendar", `macro indicator ${indicator.id} has no verified DBnomics dataset release timestamp`);
    }
    return { sourceId, sourceSeriesId, publicationTimestampStrategy, sourceBatchKey, datasetReleasedAt: release.datasetReleasedAt, observedThrough: release.observedThrough };
  }
  throw new MacroSourceRegistrationError("unsupported_source", `macro indicator ${indicator.id} uses unsupported scheduled source: ${sourceId}`);
}

function resolveBlsReleaseFamily(seriesId: string): BlsReleaseFamily | null {
  return REGISTERED_BLS_RELEASE_FAMILIES.get(seriesId) ?? null;
}

/**
 * WEO release packages contain forecasts. The macro-observation view accepts
 * only completed calendar years, keeping projections out of the page's
 * current-value and historical-observation semantics.
 */
function dbnomicsWEORelease(sourceBatchKey: string, datasetCode: string): { datasetReleasedAt: number; observedThrough: string } | null {
  const release = VERIFIED_DBNOMICS_WEO_RELEASES.get(datasetCode);
  return release?.sourceBatchKey === sourceBatchKey ? release : null;
}

/**
 * BLS returns an undated current snapshot. These are the only BLS series for
 * which this source layer has verified that the official schedule's release
 * family supplies the snapshot's known-at boundary. Do not widen this by
 * prefix: a similar-looking BLS id is not proof of the same release contract.
 */
const REGISTERED_BLS_RELEASE_FAMILIES: ReadonlyMap<string, BlsReleaseFamily> = new Map([
  ["LNS14000000", "employment"], // unemployment rate
  ["LNS11300000", "employment"], // labor-force participation rate
  ["JTS000000000000000JOL", "jolts"], // total nonfarm job openings
  ["WPUFD4", "ppi"], // final demand PPI
]);

type VerifiedDbnomicsWEORelease = {
  sourceBatchKey: string;
  datasetReleasedAt: number;
  observedThrough: string;
};

/**
 * DBnomics is a carrier, not a release-vintage provider. Only a WEO dataset
 * whose immutable batch and official IMF release date are listed here can be
 * scheduled. Adding another WEO edition is an explicit source-contract change;
 * arbitrary IFS/WDI/OECD or unverified WEO snapshots remain rejected.
 */
const VERIFIED_DBNOMICS_WEO_RELEASES: ReadonlyMap<string, VerifiedDbnomicsWEORelease> = new Map([
  ["WEO:2024-10", {
    sourceBatchKey: "imf-weo-2024-10:1729598400",
    datasetReleasedAt: 1729598400,
    observedThrough: "2023-12-31",
  }],
  ["WEO:2025-04", {
    sourceBatchKey: "imf-weo-2025-04:1745323200",
    datasetReleasedAt: 1745323200,
    observedThrough: "2024-12-31",
  }],
]);
