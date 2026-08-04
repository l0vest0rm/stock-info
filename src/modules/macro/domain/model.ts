export type MacroFrequency = "daily" | "weekly" | "monthly" | "quarterly" | "annual";
export type MacroTransmission = "earnings" | "discount" | "risk" | "flow" | "funding";
export type MacroQuality = "valid" | "suspect" | "missing";

export type MacroSeries = {
  seriesId: string;
  name: string;
  category: string;
  region: string;
  frequency: MacroFrequency;
  unit: string;
  sourceId: string;
  transmissions: MacroTransmission[];
  regions: string[];
  licenseClass: string;
  staleAfterSeconds: number;
  enabled: boolean;
  metadata: Record<string, unknown>;
  updatedAt: number;
};

export type MacroObservationVintage = {
  seriesId: string;
  observationDate: string;
  releasedAt: number;
  vintageAt: number;
  revisionNumber: number;
  value: number;
  consensus: number | null;
  previousValue: number | null;
  isPreliminary: boolean;
  qualityStatus: MacroQuality;
  sourceUrl: string | null;
  rawR2Key: string | null;
  observedAt: number;
};

export type MacroEvent = {
  eventId: string;
  scheduledAt: number;
  region: string;
  // "unclassified" is deliberate: a source title alone is not enough to
  // infer market importance. Profiles may promote it after verification.
  importance: "low" | "medium" | "high" | "unclassified";
  title: string;
  seriesId: string | null;
  actual: number | null;
  consensus: number | null;
  previous: number | null;
  unit: string | null;
  status: "scheduled" | "released" | "cancelled";
  sourceId: string;
  sourceUrl: string | null;
  metadata: Record<string, unknown>;
  updatedAt: number;
};

export type MacroSourceHealth = {
  sourceId: string;
  displayName: string;
  state: "healthy" | "degraded" | "failed" | "disabled";
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  nextRetryAt: number | null;
  latencyMs: number | null;
  metadata: Record<string, unknown>;
  updatedAt: number;
};

export type MacroUserWatchConfig = {
  ownerKey: string;
  seriesId: string;
  enabled: boolean;
  position: number;
  alertRules: unknown[];
  displayOptions: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

/** A persisted threshold match. It records the exact data vintage evaluated. */
export type MacroAlertHistoryEntry = {
  alertId: number;
  ownerKey: string;
  seriesId: string;
  observationDate: string;
  observationVintageAt: number;
  observedAt: number;
  value: number;
  ruleOperator: "gte" | "lte";
  ruleThreshold: number;
  sourceUrl: string | null;
  notificationState: "not_configured";
  notificationDetail: string | null;
  evaluatedAt: number;
  metadata: Record<string, unknown>;
};

export type DatedValue = { date: string; value: number };
