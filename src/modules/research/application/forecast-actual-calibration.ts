import {
  evaluateForecastActualCalibration,
  normalizeFormalActual,
  normalizeManagementGuidanceForecast,
  type ForecastActualCalibration,
  type ForecastKind,
  type ForecastMeasurement,
  type FormalActual,
  type FormalActualWrite,
  type ManagementGuidanceForecast,
  type ManagementGuidanceForecastWrite,
} from "../domain/forecast-actual-calibration";
import type {
  ForecastAccountingBasis,
  ForecastMetric,
  ForecastOwnershipBasis,
  ForecastRawUnit,
  ForecastShareBasis,
  NormalizedSourceForecast,
} from "../domain/forecast-consolidation";
import type { ResearchSourceReference } from "../domain/research-dossier";

type Row = Record<string, unknown>;

export type FormalActualRegistrationWrite = Omit<FormalActualWrite, "actualStatus" | "revisionNumber" | "supersedesActualId"> & {
  restatesActualId?: string | null;
};

export type ForecastActualCalibrationWrite = {
  calibrationId: string;
  securityCode: string;
  forecastKind: ForecastKind;
  forecastId: string;
  actualId: string;
  calibratedAt?: number;
};

export type ForecastActualCalibrationRecord = ForecastActualCalibration & {
  calibrationId: string;
  calibratedAt: number;
};

/** Persists a source-bound management guidance record independently of third-party research forecasts. */
export async function recordManagementGuidanceForecast(
  db: D1Database,
  input: ManagementGuidanceForecastWrite,
  createdAt = Date.now(),
): Promise<ManagementGuidanceForecast> {
  positiveTimestamp(createdAt, "createdAt");
  const guidance = normalizeManagementGuidanceForecast(input);
  if (guidance.supersedesGuidanceForecastId === guidance.forecastId) {
    throw new Error("management guidance cannot supersede itself");
  }
  if (guidance.supersedesGuidanceForecastId) {
    const predecessor = await db.prepare(`select guidance_forecast_id as forecastId
      from research_management_guidance_forecasts where guidance_forecast_id=? and security_code=?`)
      .bind(guidance.supersedesGuidanceForecastId, guidance.securityCode).first<{ forecastId: string }>();
    if (!predecessor) throw new Error("supersedesGuidanceForecastId must identify management guidance for this security");
  }
  await db.prepare(`insert into research_management_guidance_forecasts (
      guidance_forecast_id, security_code, company_id, guidance_date, metric, fiscal_year, fiscal_period,
      raw_value, raw_unit, currency, accounting_basis, ownership_basis, share_basis, normalized_value,
      normalized_unit, normalization_status, normalization_notes, guidance_conditions, source_statement,
      source_refs_json, supersedes_guidance_forecast_id, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      guidance.forecastId, guidance.securityCode, guidance.companyId, guidance.forecastDate, guidance.metric,
      guidance.fiscalYear, guidance.fiscalPeriod, guidance.rawValue, guidance.rawUnit, guidance.currency,
      guidance.accountingBasis, guidance.ownershipBasis, guidance.shareBasis, guidance.normalizedValue,
      guidance.normalizedUnit, guidance.normalizationStatus, guidance.normalizationNotes, guidance.guidanceConditions,
      guidance.sourceStatement, JSON.stringify(guidance.sourceReferences), guidance.supersedesGuidanceForecastId, createdAt,
    ).run();
  return guidance;
}

/**
 * Appends a filing-backed actual. A restatement must name the formal actual it
 * supersedes; the previous fact remains stored and is marked superseded.
 */
export async function registerFormalActual(
  db: D1Database,
  input: FormalActualRegistrationWrite,
  createdAt = Date.now(),
): Promise<FormalActual> {
  positiveTimestamp(createdAt, "createdAt");
  const securityCode = required(input.securityCode, "securityCode").toUpperCase();
  const restatesActualId = nullable(input.restatesActualId);
  let actualStatus: "original" | "restated" = "original";
  let revisionNumber = 1;
  let supersedesActualId: string | null = null;
  if (restatesActualId) {
    const prior = await db.prepare(`select actual_id as actualId, security_code as securityCode, metric, fiscal_period as fiscalPeriod,
        actual_status as actualStatus, revision_number as revisionNumber from research_formal_actuals where actual_id=?`)
      .bind(restatesActualId).first<Row>();
    if (!prior) throw new Error("restated formal actual target not found");
    if (required(prior.securityCode, "stored actual securityCode") !== securityCode
      || required(prior.metric, "stored actual metric") !== input.metric
      || required(prior.fiscalPeriod, "stored actual fiscalPeriod") !== input.fiscalPeriod) {
      throw new Error("restated formal actual must match the superseded security, metric and fiscal period");
    }
    if (prior.actualStatus !== "original" && prior.actualStatus !== "restated") throw new Error("restated formal actual target is not current");
    actualStatus = "restated";
    revisionNumber = number(prior.revisionNumber, "stored actual revisionNumber") + 1;
    supersedesActualId = restatesActualId;
  } else {
    const current = await db.prepare(`select actual_id as actualId from research_formal_actuals
      where security_code=? and metric=? and fiscal_period=? and actual_status in ('original','restated') limit 1`)
      .bind(securityCode, input.metric, input.fiscalPeriod).first<Row>();
    if (current) throw new Error("a current formal actual already exists; register a restatement explicitly");
  }
  const actual = normalizeFormalActual({
    ...input, securityCode, actualStatus, revisionNumber, supersedesActualId,
    restatementNote: input.restatementNote ?? null,
  });
  const insert = db.prepare(`insert into research_formal_actuals (
      actual_id, security_code, company_id, metric, fiscal_year, fiscal_period, raw_value, raw_unit, currency,
      accounting_basis, ownership_basis, share_basis, normalized_value, normalized_unit, normalization_status,
      normalization_notes, actual_status, revision_number, supersedes_actual_id, restatement_note, filed_at,
      source_statement, source_refs_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      actual.actualId, actual.securityCode, actual.companyId, actual.metric, actual.fiscalYear, actual.fiscalPeriod,
      actual.rawValue, actual.rawUnit, actual.currency, actual.accountingBasis, actual.ownershipBasis, actual.shareBasis,
      actual.normalizedValue, actual.normalizedUnit, actual.normalizationStatus, actual.normalizationNotes,
      actual.actualStatus, actual.revisionNumber, actual.supersedesActualId, actual.restatementNote, actual.filedAt,
      actual.sourceStatement, JSON.stringify(actual.sourceReferences), createdAt,
    );
  if (supersedesActualId) {
    await db.batch([
      insert,
      db.prepare("update research_formal_actuals set actual_status='superseded' where actual_id=? and actual_status in ('original','restated')").bind(supersedesActualId),
    ]);
  } else await insert.run();
  return actual;
}

/** Loads a historical forecast and actual, evaluates their explicit bases, and persists either an error or a visible block. */
export async function createForecastActualCalibration(
  db: D1Database,
  input: ForecastActualCalibrationWrite,
): Promise<ForecastActualCalibrationRecord> {
  const securityCode = required(input.securityCode, "securityCode").toUpperCase();
  const calibrationId = required(input.calibrationId, "calibrationId");
  const calibratedAt = input.calibratedAt ?? Date.now();
  positiveTimestamp(calibratedAt, "calibratedAt");
  const [forecast, actual] = await Promise.all([
    loadForecastMeasurement(db, input.forecastKind, required(input.forecastId, "forecastId"), securityCode),
    loadFormalActualById(db, required(input.actualId, "actualId"), securityCode),
  ]);
  const result = evaluateForecastActualCalibration(forecast, actual);
  await db.prepare(`insert into research_forecast_actual_calibration_records (
      calibration_id, security_code, company_id, forecast_kind, forecast_id, actual_id, metric, fiscal_period,
      currency, normalized_unit, accounting_basis, ownership_basis, share_basis, forecast_normalized_value,
      actual_normalized_value, absolute_error, percentage_error, comparability_status, comparability_reason, calibrated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      calibrationId, result.securityCode, result.companyId, result.forecastKind, result.forecastId, result.actualId,
      result.metric, result.fiscalPeriod, result.currency, result.normalizedUnit, result.accountingBasis,
      result.ownershipBasis, result.shareBasis, result.forecastNormalizedValue, result.actualNormalizedValue,
      result.absoluteError, result.percentageError, result.comparabilityStatus, result.comparabilityReason, calibratedAt,
    ).run();
  return { ...result, calibrationId, calibratedAt };
}

export async function loadFormalActuals(db: D1Database, securityCode: string, limit = 100): Promise<FormalActual[]> {
  const rows = await db.prepare(`select actual_id as actualId, security_code as securityCode, company_id as companyId, metric,
      fiscal_year as fiscalYear, fiscal_period as fiscalPeriod, raw_value as rawValue, raw_unit as rawUnit, currency,
      accounting_basis as accountingBasis, ownership_basis as ownershipBasis, share_basis as shareBasis,
      normalized_value as normalizedValue, normalized_unit as normalizedUnit, normalization_status as normalizationStatus,
      normalization_notes as normalizationNotes, actual_status as actualStatus, revision_number as revisionNumber,
      supersedes_actual_id as supersedesActualId, restatement_note as restatementNote, filed_at as filedAt,
      source_statement as sourceStatement, source_refs_json as sourceReferencesJson
    from research_formal_actuals where security_code=? order by fiscal_year desc, metric, revision_number desc, filed_at desc limit ?`)
    .bind(required(securityCode, "securityCode").toUpperCase(), boundedLimit(limit)).all<Row>();
  return rows.results.map(mapActual);
}

export async function loadManagementGuidanceForecasts(db: D1Database, securityCode: string, limit = 100): Promise<ManagementGuidanceForecast[]> {
  const rows = await db.prepare(`select guidance_forecast_id as forecastId, security_code as securityCode, company_id as companyId,
      guidance_date as forecastDate, metric, fiscal_year as fiscalYear, fiscal_period as fiscalPeriod, raw_value as rawValue,
      raw_unit as rawUnit, currency, accounting_basis as accountingBasis, ownership_basis as ownershipBasis,
      share_basis as shareBasis, normalized_value as normalizedValue, normalized_unit as normalizedUnit,
      normalization_status as normalizationStatus, normalization_notes as normalizationNotes, guidance_conditions as guidanceConditions,
      source_statement as sourceStatement, source_refs_json as sourceReferencesJson,
      supersedes_guidance_forecast_id as supersedesGuidanceForecastId
    from research_management_guidance_forecasts where security_code=? order by guidance_date desc, created_at desc limit ?`)
    .bind(required(securityCode, "securityCode").toUpperCase(), boundedLimit(limit)).all<Row>();
  return rows.results.map(mapManagementGuidance);
}

export async function loadForecastActualCalibrationRecords(db: D1Database, securityCode: string, limit = 200): Promise<ForecastActualCalibrationRecord[]> {
  const rows = await db.prepare(`select calibration_id as calibrationId, security_code as securityCode, company_id as companyId,
      forecast_kind as forecastKind, forecast_id as forecastId, actual_id as actualId, metric, fiscal_period as fiscalPeriod,
      currency, normalized_unit as normalizedUnit, accounting_basis as accountingBasis, ownership_basis as ownershipBasis,
      share_basis as shareBasis, forecast_normalized_value as forecastNormalizedValue,
      actual_normalized_value as actualNormalizedValue, absolute_error as absoluteError, percentage_error as percentageError,
      comparability_status as comparabilityStatus, comparability_reason as comparabilityReason, calibrated_at as calibratedAt
    from research_forecast_actual_calibration_records where security_code=? order by calibrated_at desc, calibration_id desc limit ?`)
    .bind(required(securityCode, "securityCode").toUpperCase(), boundedLimit(limit)).all<Row>();
  return rows.results.map(mapCalibration);
}

async function loadForecastMeasurement(db: D1Database, kind: ForecastKind, forecastId: string, securityCode: string): Promise<ForecastMeasurement> {
  if (kind === "management_guidance") {
    const row = await db.prepare(`select guidance_forecast_id as forecastId, security_code as securityCode, company_id as companyId,
        guidance_date as forecastDate, metric, fiscal_year as fiscalYear, fiscal_period as fiscalPeriod, raw_value as rawValue,
        raw_unit as rawUnit, currency, accounting_basis as accountingBasis, ownership_basis as ownershipBasis,
        share_basis as shareBasis, normalized_value as normalizedValue, normalized_unit as normalizedUnit,
        normalization_status as normalizationStatus, normalization_notes as normalizationNotes
      from research_management_guidance_forecasts where guidance_forecast_id=? and security_code=?`).bind(forecastId, securityCode).first<Row>();
    if (!row) throw new Error("management guidance forecast not found");
    return mapMeasurement(row, "management_guidance");
  }
  const row = await db.prepare(`select forecast_id as forecastId, security_code as securityCode, company_id as companyId,
      forecast_date as forecastDate, metric, fiscal_year as fiscalYear, fiscal_period as fiscalPeriod, raw_value as rawValue,
      raw_unit as rawUnit, currency, accounting_basis as accountingBasis, ownership_basis as ownershipBasis,
      share_basis as shareBasis, normalized_value as normalizedValue, normalized_unit as normalizedUnit,
      normalization_status as normalizationStatus, normalization_notes as normalizationNotes
    from research_source_forecasts where forecast_id=? and security_code=?`).bind(forecastId, securityCode).first<Row>();
  if (!row) throw new Error("third-party source forecast not found");
  return mapMeasurement(row, "third_party_forecast");
}

/** Loads one persisted formal actual for a model/calibration boundary; callers cannot supply a raw substitute. */
export async function loadFormalActualById(db: D1Database, actualId: string, securityCode: string): Promise<FormalActual> {
  const row = await db.prepare(`select actual_id as actualId, security_code as securityCode, company_id as companyId, metric,
      fiscal_year as fiscalYear, fiscal_period as fiscalPeriod, raw_value as rawValue, raw_unit as rawUnit, currency,
      accounting_basis as accountingBasis, ownership_basis as ownershipBasis, share_basis as shareBasis,
      normalized_value as normalizedValue, normalized_unit as normalizedUnit, normalization_status as normalizationStatus,
      normalization_notes as normalizationNotes, actual_status as actualStatus, revision_number as revisionNumber,
      supersedes_actual_id as supersedesActualId, restatement_note as restatementNote, filed_at as filedAt,
      source_statement as sourceStatement, source_refs_json as sourceReferencesJson
    from research_formal_actuals where actual_id=? and security_code=?`).bind(actualId, securityCode).first<Row>();
  if (!row) throw new Error("formal actual not found");
  return mapActual(row);
}

function mapActual(row: Row): FormalActual {
  return {
    ...mapMeasurement({ ...row, forecastId: row.actualId, forecastDate: row.filedAt }, "third_party_forecast"), actualId: required(row.actualId, "actualId"),
    actualStatus: enumValue(row.actualStatus, ["original", "restated", "superseded"] as const, "actualStatus"),
    revisionNumber: number(row.revisionNumber, "revisionNumber"), supersedesActualId: nullable(row.supersedesActualId),
    restatementNote: nullable(row.restatementNote), filedAt: required(row.filedAt, "filedAt"),
    sourceStatement: required(row.sourceStatement, "sourceStatement"), sourceReferences: parseReferences(row.sourceReferencesJson),
    epistemicType: "observed_fact",
  };
}

function mapManagementGuidance(row: Row): ManagementGuidanceForecast {
  return {
    ...mapMeasurement(row, "management_guidance"), guidanceConditions: required(row.guidanceConditions, "guidanceConditions"),
    sourceStatement: required(row.sourceStatement, "sourceStatement"), sourceReferences: parseReferences(row.sourceReferencesJson),
    supersedesGuidanceForecastId: nullable(row.supersedesGuidanceForecastId), epistemicType: "management_guidance",
  };
}

function mapMeasurement(row: Row, forecastKind: ForecastKind): ForecastMeasurement {
  return {
    forecastKind, forecastId: required(row.forecastId, "forecastId"), securityCode: required(row.securityCode, "securityCode"),
    companyId: nullable(row.companyId), forecastDate: required(row.forecastDate ?? row.filedAt, "forecastDate"),
    metric: required(row.metric, "metric") as ForecastMetric, fiscalYear: number(row.fiscalYear, "fiscalYear"),
    fiscalPeriod: required(row.fiscalPeriod, "fiscalPeriod"), rawValue: number(row.rawValue, "rawValue"),
    rawUnit: required(row.rawUnit, "rawUnit") as ForecastRawUnit, currency: nullable(row.currency),
    accountingBasis: required(row.accountingBasis, "accountingBasis") as ForecastAccountingBasis,
    ownershipBasis: required(row.ownershipBasis, "ownershipBasis") as ForecastOwnershipBasis,
    shareBasis: required(row.shareBasis, "shareBasis") as ForecastShareBasis,
    normalizedValue: nullableNumber(row.normalizedValue), normalizedUnit: nullable(row.normalizedUnit) as NormalizedSourceForecast["normalizedUnit"],
    normalizationStatus: enumValue(row.normalizationStatus, ["comparable", "needs_review"] as const, "normalizationStatus"),
    normalizationNotes: nullable(row.normalizationNotes),
  };
}

function mapCalibration(row: Row): ForecastActualCalibrationRecord {
  return {
    ruleVersion: "forecast-actual-calibration.v1", calibrationId: required(row.calibrationId, "calibrationId"),
    securityCode: required(row.securityCode, "securityCode"), companyId: nullable(row.companyId),
    forecastKind: enumValue(row.forecastKind, ["management_guidance", "third_party_forecast"] as const, "forecastKind"),
    forecastId: required(row.forecastId, "forecastId"), actualId: required(row.actualId, "actualId"),
    metric: required(row.metric, "metric") as ForecastMetric, fiscalPeriod: required(row.fiscalPeriod, "fiscalPeriod"),
    currency: nullable(row.currency), normalizedUnit: nullable(row.normalizedUnit) as NormalizedSourceForecast["normalizedUnit"],
    accountingBasis: nullable(row.accountingBasis) as ForecastAccountingBasis | null,
    ownershipBasis: nullable(row.ownershipBasis) as ForecastOwnershipBasis | null,
    shareBasis: nullable(row.shareBasis) as ForecastShareBasis | null,
    forecastNormalizedValue: nullableNumber(row.forecastNormalizedValue), actualNormalizedValue: nullableNumber(row.actualNormalizedValue),
    absoluteError: nullableNumber(row.absoluteError), percentageError: nullableNumber(row.percentageError),
    comparabilityStatus: enumValue(row.comparabilityStatus, ["comparable", "not_comparable"] as const, "comparabilityStatus"),
    comparabilityReason: nullable(row.comparabilityReason) as ForecastActualCalibration["comparabilityReason"],
    calibratedAt: number(row.calibratedAt, "calibratedAt"),
  };
}

function parseReferences(value: unknown): ResearchSourceReference[] {
  try { const parsed = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed as ResearchSourceReference[] : []; }
  catch { throw new Error("stored source references JSON is invalid"); }
}
function required(value: unknown, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function nullable(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function number(value: unknown, label: string): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error(`${label} must be finite`); return result; }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : number(value, "stored number"); }
function positiveTimestamp(value: number, label: string): void { if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer timestamp`); }
function boundedLimit(value: number): number { return Math.min(Math.max(Math.floor(value), 1), 500); }
function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T { const text = required(value, label); if (!values.includes(text as T)) throw new Error(`${label} is invalid`); return text as T; }
