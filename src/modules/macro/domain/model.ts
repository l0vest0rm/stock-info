export type MacroIndicatorFrequency = "daily" | "weekly" | "monthly" | "quarterly" | "annual";
export type MacroIndicatorLeadLag = "leading" | "coincident" | "lagging";
export type MacroMeasurementKind = string;
export type MacroDerivedMeasureMethod = string;

/**
 * One concrete regional statistical series plus all metadata needed to render
 * the generic macro catalog. Dimension metadata is intentionally repeated in
 * this small catalog; `macro_data` remains numeric facts only.
 */
export type MacroIndicator = {
  id: number;
  metricId: number;
  categoryId: number;
  regionCode: string;
  definitionId: number;
  regionName: string;
  regionSort: number;
  categoryCode: string;
  categoryName: string;
  categorySort: number;
  metricCode: string;
  metricName: string;
  metricDescription: string;
  metricSort: number;
  statisticalDefinition: string;
  name: string;
  frequency: MacroIndicatorFrequency;
  unit: string;
  unitFormat: string;
  measurementKind: MacroMeasurementKind;
  yoyMethod: MacroDerivedMeasureMethod;
  yoyBasePeriods: number;
  yoyDisplayFormat: string;
  momMethod: MacroDerivedMeasureMethod;
  momBasePeriods: number;
  momDisplayFormat: string;
  defaultTrendPeriods: number;
  enabled: boolean;
  sourceId: string | null;
  sourceSeriesId: string | null;
  sourceUrl: string | null;
  publisher: string | null;
  publicationTimestampStrategy: string | null;
  sourceBatchKey: string | null;
  seasonalAdjustment: string | null;
  leadLag: MacroIndicatorLeadLag | null;
  transformMethod: string | null;
  staleAfterSeconds: number;
  refreshIntervalSeconds: number;
  revisionLookbackPeriods: number;
  nextFetchAt: number | null;
  lastSuccessAt: number | null;
  fetchLeaseUntil: number | null;
  consecutiveFailures: number;
  lastError: string | null;
};

/** A raw fact row. `periodDay` is YYYYMMDD and is always a period start. */
export type MacroDataPoint = {
  indicatorId: number;
  periodDay: number;
  publishedAt: number;
  value: number;
};

/** Input accepted by the repository before it normalizes a calendar period. */
export type MacroDataWrite = Omit<MacroDataPoint, "periodDay"> & {
  period: string | number | Date;
  frequency: MacroIndicatorFrequency;
};
