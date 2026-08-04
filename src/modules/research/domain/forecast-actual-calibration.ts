import {
  normalizeSourceForecast,
  type ForecastAccountingBasis,
  type ForecastMetric,
  type ForecastOwnershipBasis,
  type ForecastRawUnit,
  type ForecastShareBasis,
  type NormalizedSourceForecast,
} from "./forecast-consolidation";
import { assertSourceReferences, type ResearchSourceReference } from "./research-dossier";

export const FORECAST_ACTUAL_CALIBRATION_RULE_VERSION = "forecast-actual-calibration.v1";

export type ForecastKind = "management_guidance" | "third_party_forecast";
export type FormalActualStatus = "original" | "restated" | "superseded";
export type CalibrationComparabilityReason =
  | "actual_restatement"
  | "actual_superseded"
  | "metric_mismatch"
  | "fiscal_period_mismatch"
  | "forecast_not_normalized"
  | "actual_not_normalized"
  | "currency_mismatch"
  | "normalized_unit_mismatch"
  | "accounting_basis_mismatch"
  | "ownership_basis_mismatch"
  | "share_basis_mismatch";

/**
 * A formal actual may anchor a new model only when it is a current,
 * normalized filing fact.  This is deliberately stricter than merely being
 * displayable in the historical ledger: a restatement stays available for
 * audit, but cannot silently replace a model's historical starting point.
 */
export type FormalActualModelAnchorBlockReason =
  | "actual_restatement"
  | "actual_superseded"
  | "actual_not_normalized"
  | "actual_missing_filing_evidence";

export type ForecastMeasurement = {
  forecastKind: ForecastKind;
  forecastId: string;
  securityCode: string;
  companyId: string | null;
  forecastDate: string;
  metric: ForecastMetric;
  fiscalYear: number;
  fiscalPeriod: string;
  rawValue: number;
  rawUnit: ForecastRawUnit;
  currency: string | null;
  accountingBasis: ForecastAccountingBasis;
  ownershipBasis: ForecastOwnershipBasis;
  shareBasis: ForecastShareBasis;
  normalizedValue: number | null;
  normalizedUnit: NormalizedSourceForecast["normalizedUnit"];
  normalizationStatus: NormalizedSourceForecast["normalizationStatus"];
  normalizationNotes: string | null;
};

export type FormalActual = Omit<ForecastMeasurement, "forecastKind" | "forecastId" | "forecastDate"> & {
  actualId: string;
  actualStatus: FormalActualStatus;
  revisionNumber: number;
  supersedesActualId: string | null;
  restatementNote: string | null;
  filedAt: string;
  sourceStatement: string;
  sourceReferences: ResearchSourceReference[];
  epistemicType: "observed_fact";
};

export type ManagementGuidanceForecast = ForecastMeasurement & {
  guidanceConditions: string;
  sourceStatement: string;
  sourceReferences: ResearchSourceReference[];
  supersedesGuidanceForecastId: string | null;
  epistemicType: "management_guidance";
};

export type FormalActualWrite = {
  actualId: string;
  securityCode: string;
  companyId: string | null;
  metric: ForecastMetric;
  fiscalYear: number;
  fiscalPeriod: string;
  rawValue: number;
  rawUnit: ForecastRawUnit;
  currency: string | null;
  accountingBasis: ForecastAccountingBasis;
  ownershipBasis: ForecastOwnershipBasis;
  shareBasis: ForecastShareBasis;
  filedAt: string;
  sourceStatement: string;
  sourceReferences: ResearchSourceReference[];
  actualStatus: Exclude<FormalActualStatus, "superseded">;
  revisionNumber: number;
  supersedesActualId?: string | null;
  restatementNote?: string | null;
};

export type ManagementGuidanceForecastWrite = {
  guidanceForecastId: string;
  securityCode: string;
  companyId: string | null;
  guidanceDate: string;
  metric: ForecastMetric;
  fiscalYear: number;
  fiscalPeriod: string;
  rawValue: number;
  rawUnit: ForecastRawUnit;
  currency: string | null;
  accountingBasis: ForecastAccountingBasis;
  ownershipBasis: ForecastOwnershipBasis;
  shareBasis: ForecastShareBasis;
  guidanceConditions: string;
  sourceStatement: string;
  sourceReferences: ResearchSourceReference[];
  supersedesGuidanceForecastId?: string | null;
};

export type ForecastActualCalibration = {
  ruleVersion: typeof FORECAST_ACTUAL_CALIBRATION_RULE_VERSION;
  forecastKind: ForecastKind;
  forecastId: string;
  actualId: string;
  securityCode: string;
  companyId: string | null;
  metric: ForecastMetric;
  fiscalPeriod: string;
  currency: string | null;
  normalizedUnit: NormalizedSourceForecast["normalizedUnit"];
  accountingBasis: ForecastAccountingBasis | null;
  ownershipBasis: ForecastOwnershipBasis | null;
  shareBasis: ForecastShareBasis | null;
  forecastNormalizedValue: number | null;
  actualNormalizedValue: number | null;
  absoluteError: number | null;
  percentageError: number | null;
  comparabilityStatus: "comparable" | "not_comparable";
  comparabilityReason: CalibrationComparabilityReason | null;
};

/**
 * The forecast workspace must describe only the filing-backed calibration
 * ledger.  A recorded non-comparable pairing is useful audit evidence, but it
 * must not be presented as a successful error statistic.
 */
export function formalActualCalibrationLayerStatus(
  records: Array<Pick<ForecastActualCalibration, "comparabilityStatus">>,
): "available" | "partial" | "unavailable" {
  if (records.some((record) => record.comparabilityStatus === "comparable")) return "available";
  return records.length ? "partial" : "unavailable";
}

/** Normalizes a filing-backed actual with exactly the same rules as source forecasts. */
export function normalizeFormalActual(input: FormalActualWrite): FormalActual {
  validateFormalActual(input);
  const normalized = normalizeMeasurement({
    id: input.actualId, forecastDate: input.filedAt, metric: input.metric, fiscalYear: input.fiscalYear,
    rawValue: input.rawValue, rawUnit: input.rawUnit, currency: input.currency, accountingBasis: input.accountingBasis,
    ownershipBasis: input.ownershipBasis, shareBasis: input.shareBasis,
  });
  return {
    actualId: required(input.actualId, "actualId"), securityCode: securityCode(input.securityCode), companyId: input.companyId,
    metric: input.metric, fiscalYear: input.fiscalYear, fiscalPeriod: input.fiscalPeriod, rawValue: input.rawValue, rawUnit: input.rawUnit,
    currency: normalized.currency, accountingBasis: input.accountingBasis, ownershipBasis: input.ownershipBasis, shareBasis: input.shareBasis,
    normalizedValue: normalized.normalizedValue, normalizedUnit: normalized.normalizedUnit,
    normalizationStatus: normalized.normalizationStatus, normalizationNotes: normalized.normalizationNotes,
    actualStatus: input.actualStatus, revisionNumber: input.revisionNumber, supersedesActualId: nullable(input.supersedesActualId),
    restatementNote: nullable(input.restatementNote), filedAt: requiredDate(input.filedAt, "filedAt"),
    sourceStatement: required(input.sourceStatement, "sourceStatement"), sourceReferences: input.sourceReferences,
    epistemicType: "observed_fact",
  };
}

/** Management guidance stays separate from third-party reports even though both can later be calibrated. */
export function normalizeManagementGuidanceForecast(input: ManagementGuidanceForecastWrite): ManagementGuidanceForecast {
  required(input.guidanceForecastId, "guidanceForecastId");
  validateMeasurement(input, "management guidance");
  requiredDate(input.guidanceDate, "guidanceDate");
  required(input.guidanceConditions, "guidanceConditions");
  required(input.sourceStatement, "sourceStatement");
  assertSourceReferences("management_guidance", input.sourceReferences);
  const normalized = normalizeMeasurement({
    id: input.guidanceForecastId, forecastDate: input.guidanceDate, metric: input.metric, fiscalYear: input.fiscalYear,
    rawValue: input.rawValue, rawUnit: input.rawUnit, currency: input.currency, accountingBasis: input.accountingBasis,
    ownershipBasis: input.ownershipBasis, shareBasis: input.shareBasis,
  });
  return {
    forecastKind: "management_guidance", forecastId: input.guidanceForecastId, securityCode: securityCode(input.securityCode), companyId: input.companyId,
    forecastDate: input.guidanceDate, metric: input.metric, fiscalYear: input.fiscalYear, fiscalPeriod: input.fiscalPeriod,
    rawValue: input.rawValue, rawUnit: input.rawUnit, currency: normalized.currency, accountingBasis: input.accountingBasis,
    ownershipBasis: input.ownershipBasis, shareBasis: input.shareBasis, normalizedValue: normalized.normalizedValue,
    normalizedUnit: normalized.normalizedUnit, normalizationStatus: normalized.normalizationStatus, normalizationNotes: normalized.normalizationNotes,
    guidanceConditions: input.guidanceConditions, sourceStatement: input.sourceStatement, sourceReferences: input.sourceReferences,
    supersedesGuidanceForecastId: nullable(input.supersedesGuidanceForecastId), epistemicType: "management_guidance",
  };
}

/**
 * Computes an immutable calibration observation.  It never falls back across
 * period, currency, unit or accounting bases, and every restated actual stays
 * visibly not comparable instead of silently changing the historical error.
 */
export function evaluateForecastActualCalibration(
  forecast: ForecastMeasurement,
  actual: FormalActual,
): ForecastActualCalibration {
  if (forecast.securityCode !== actual.securityCode) throw new Error("forecast and formal actual must belong to the same security");
  const base = {
    ruleVersion: FORECAST_ACTUAL_CALIBRATION_RULE_VERSION,
    forecastKind: forecast.forecastKind, forecastId: forecast.forecastId, actualId: actual.actualId,
    securityCode: forecast.securityCode, companyId: forecast.companyId ?? actual.companyId,
    metric: forecast.metric, fiscalPeriod: forecast.fiscalPeriod,
    currency: forecast.currency, normalizedUnit: forecast.normalizedUnit,
    accountingBasis: forecast.accountingBasis, ownershipBasis: forecast.ownershipBasis, shareBasis: forecast.shareBasis,
    forecastNormalizedValue: forecast.normalizedValue, actualNormalizedValue: actual.normalizedValue,
  } as const;
  const reason = comparabilityReason(forecast, actual);
  if (reason) return { ...base, absoluteError: null, percentageError: null, comparabilityStatus: "not_comparable", comparabilityReason: reason };
  const forecastValue = forecast.normalizedValue!;
  const actualValue = actual.normalizedValue!;
  const absoluteError = Math.abs(forecastValue - actualValue);
  const percentageError = forecastValue === 0 ? null : (actualValue - forecastValue) / Math.abs(forecastValue);
  return { ...base, absoluteError, percentageError, comparabilityStatus: "comparable", comparabilityReason: null };
}

/** Returns a visible blocking reason instead of permitting an unsafe model anchor. */
export function formalActualModelAnchorBlockReason(actual: FormalActual): FormalActualModelAnchorBlockReason | null {
  if (actual.actualStatus === "restated") return "actual_restatement";
  if (actual.actualStatus === "superseded") return "actual_superseded";
  if (actual.normalizationStatus !== "comparable" || actual.normalizedValue === null || !actual.normalizedUnit) return "actual_not_normalized";
  if (!actual.sourceReferences.some((reference) => reference.sourceKind === "filing")) return "actual_missing_filing_evidence";
  return null;
}

function comparabilityReason(forecast: ForecastMeasurement, actual: FormalActual): CalibrationComparabilityReason | null {
  if (actual.actualStatus === "restated") return "actual_restatement";
  if (actual.actualStatus === "superseded") return "actual_superseded";
  if (forecast.metric !== actual.metric) return "metric_mismatch";
  if (forecast.fiscalPeriod !== actual.fiscalPeriod) return "fiscal_period_mismatch";
  if (forecast.normalizationStatus !== "comparable" || forecast.normalizedValue === null || !forecast.normalizedUnit) return "forecast_not_normalized";
  if (actual.normalizationStatus !== "comparable" || actual.normalizedValue === null || !actual.normalizedUnit) return "actual_not_normalized";
  if (forecast.currency !== actual.currency) return "currency_mismatch";
  if (forecast.normalizedUnit !== actual.normalizedUnit) return "normalized_unit_mismatch";
  if (forecast.accountingBasis !== actual.accountingBasis) return "accounting_basis_mismatch";
  if (forecast.ownershipBasis !== actual.ownershipBasis) return "ownership_basis_mismatch";
  if (forecast.shareBasis !== actual.shareBasis) return "share_basis_mismatch";
  return null;
}

function validateFormalActual(input: FormalActualWrite): void {
  required(input.actualId, "actualId");
  validateMeasurement(input, "formal actual");
  requiredDate(input.filedAt, "filedAt");
  required(input.sourceStatement, "sourceStatement");
  assertSourceReferences("observed_fact", input.sourceReferences);
  if (!input.sourceReferences.some((reference) => reference.sourceKind === "filing")) throw new Error("formal actual requires a filing source reference");
  if (!Number.isInteger(input.revisionNumber) || input.revisionNumber <= 0) throw new Error("formal actual revisionNumber must be a positive integer");
  const supersedes = nullable(input.supersedesActualId);
  const restatement = nullable(input.restatementNote);
  if (input.actualStatus === "original" && (supersedes || restatement)) throw new Error("original formal actual cannot carry a restatement link");
  if (input.actualStatus === "restated" && (!supersedes || !restatement)) throw new Error("restated formal actual requires supersedesActualId and restatementNote");
}

function validateMeasurement(input: { securityCode: string; metric: ForecastMetric; fiscalYear: number; fiscalPeriod: string; rawValue: number; rawUnit: ForecastRawUnit; accountingBasis: ForecastAccountingBasis; ownershipBasis: ForecastOwnershipBasis; shareBasis: ForecastShareBasis }, label: string): void {
  securityCode(input.securityCode);
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1900 || input.fiscalYear > 2200) throw new Error(`${label} fiscalYear is invalid`);
  const period = required(input.fiscalPeriod, `${label} fiscalPeriod`);
  if (!new RegExp(`^${input.fiscalYear}(FY|Q[1-4])$`).test(period)) throw new Error(`${label} fiscalPeriod must match fiscalYear`);
  if (!Number.isFinite(input.rawValue)) throw new Error(`${label} rawValue must be finite`);
}

function normalizeMeasurement(input: { id: string; forecastDate: string; metric: ForecastMetric; fiscalYear: number; rawValue: number; rawUnit: ForecastRawUnit; currency: string | null; accountingBasis: ForecastAccountingBasis; ownershipBasis: ForecastOwnershipBasis; shareBasis: ForecastShareBasis }): NormalizedSourceForecast {
  return normalizeSourceForecast({
    forecastId: input.id, institution: "not_used_for_measurement", forecastDate: input.forecastDate, metric: input.metric,
    fiscalYear: input.fiscalYear, rawValue: input.rawValue, rawUnit: input.rawUnit, currency: normalizeCurrency(input.currency),
    accountingBasis: input.accountingBasis, ownershipBasis: input.ownershipBasis, shareBasis: input.shareBasis, createdAt: 0,
  });
}

function securityCode(value: string): string { return required(value, "securityCode").toUpperCase(); }
function normalizeCurrency(value: string | null): string | null { const result = String(value ?? "").trim().toUpperCase(); return result || null; }
function required(value: string | null | undefined, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function nullable(value: string | null | undefined): string | null { const result = String(value ?? "").trim(); return result || null; }
function requiredDate(value: string, label: string): string { const result = required(value, label); if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error(`${label} must be YYYY-MM-DD`); return result; }
