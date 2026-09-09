import type { Database } from "../../../platform/contracts";
import { getKvCache, getKvCacheByLegacyKey, putKvCache, putKvCacheByLegacyKey } from "../../../db/queries";
import { normalizeSecurityCode } from "../../../shared/codes";
import {
  type StoredCompanyReportDiscoveryValue,
  type StoredCompanyReportDiscoveryReport,
  type StoredCompanyReportDiscoveryTask,
} from "../domain/report-types";
import { COMPANY_REPORT_DISCOVERY_NAMESPACE } from "../domain/report-policy";
import { asRecord, parseJson, text } from "../domain/report-values";

export async function readAppJson<T>(db: Database, key: string): Promise<T | null> {
  const row = await getKvCacheByLegacyKey(db, key);
  if (!row?.valueJson) {
    return null;
  }
  try {
    return JSON.parse(row.valueJson) as T;
  } catch {
    return null;
  }
}

export async function writeAppJson(db: Database, key: string, value: unknown, ttlMs: number): Promise<void> {
  const now = Date.now();
  await putKvCacheByLegacyKey(db, {
    key,
    valueJson: JSON.stringify(value),
    expiresAt: now + Math.max(1, ttlMs),
    updatedAt: now,
  });
}

export async function readStoredCompanyReportDiscovery(
  db: Database,
  securityCode: string,
): Promise<StoredCompanyReportDiscoveryValue | null> {
  const row = await getKvCache(db, COMPANY_REPORT_DISCOVERY_NAMESPACE, normalizeSecurityCode(securityCode));
  if (!row?.valueJson) return null;
  const parsed = asRecord(parseJson(row.valueJson));
  if (!parsed) return null;
  const report = parseStoredCompanyReportDiscoveryReport(parsed.report);
  const task = parseStoredCompanyReportDiscoveryTask(parsed.task);
  const lastSuccessfulCompletedAt = parsed.lastSuccessfulCompletedAt === null || parsed.lastSuccessfulCompletedAt === undefined
    ? null
    : Number(parsed.lastSuccessfulCompletedAt);
  if (!report && !task) return null;
  return {
    report,
    task,
    lastSuccessfulCompletedAt: Number.isFinite(lastSuccessfulCompletedAt) ? lastSuccessfulCompletedAt : null,
  };
}

export async function writeStoredCompanyReportDiscovery(
  db: Database,
  securityCode: string,
  value: StoredCompanyReportDiscoveryValue,
): Promise<void> {
  await putKvCache(db, {
    namespace: COMPANY_REPORT_DISCOVERY_NAMESPACE,
    key: normalizeSecurityCode(securityCode),
    valueJson: JSON.stringify(value),
    expiresAt: null,
    updatedAt: value.report?.projection.cachedAt ?? value.task?.updatedAt ?? value.lastSuccessfulCompletedAt ?? Date.now(),
  });
}

function parseStoredCompanyReportDiscoveryReport(value: unknown): StoredCompanyReportDiscoveryReport | null {
  const row = asRecord(value);
  const response = asRecord(row?.response);
  const projection = asRecord(row?.projection);
  const responseText = text(response?.text);
  const securityCode = text(projection?.securityCode);
  const reportsFound = Number(projection?.reportsFound);
  const reportsRejected = Number(projection?.reportsRejected);
  const sourceRows = Number(projection?.sourceRows);
  const cachedAt = Number(projection?.cachedAt);
  if (
    !responseText
    || !securityCode
    || !Number.isFinite(reportsFound)
    || !Number.isFinite(reportsRejected)
    || !Number.isFinite(sourceRows)
    || !Number.isFinite(cachedAt)
  ) {
    return null;
  }
  return {
    response: { text: responseText },
    projection: {
      securityCode,
      reportsFound,
      reportsRejected,
      sourceRows,
      cachedAt,
    },
  };
}

function parseStoredCompanyReportDiscoveryTask(value: unknown): StoredCompanyReportDiscoveryTask | null {
  const row = asRecord(value);
  const name = text(row?.name);
  const status = text(row?.status) as StoredCompanyReportDiscoveryTask["status"];
  const createdAt = Number(row?.createdAt);
  const updatedAt = Number(row?.updatedAt);
  if (!name || !new Set<StoredCompanyReportDiscoveryTask["status"]>(["queued", "running", "completed", "failed", "blocked"]).has(status) || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) {
    return null;
  }
  const completedAt = row?.completedAt === null || row?.completedAt === undefined ? null : Number(row?.completedAt);
  return {
    name,
    status,
    errorMessage: text(row?.errorMessage) || null,
    createdAt,
    updatedAt,
    completedAt: Number.isFinite(completedAt) ? completedAt : null,
  };
}
