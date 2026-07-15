import {
  fetchEastmoneyPerformanceForecastPage,
  fetchEastmoneyPerformanceReportPage,
  type EastmoneyDataPage,
} from "../../../adapters/eastmoney";
import { getAppKv, putAppKv } from "../../../db/queries";
import { latestCompletedQuarterEndDate } from "../../../shared/cache-policy";
import { normalizeSecurityCode } from "../../../shared/codes";
import {
  getFinancialStatementsSnapshot,
  putFinancialStatementsSnapshot,
  type FinancialProvisionalData,
} from "../../../storage/market-data";
import type { Bindings, FinancialStatement } from "../../../types";
import {
  ensureFinancialSourceMetadata,
  mergeProvisionalFinancialStatements,
} from "./select-quarterly-income-statements";

const PAGE_SIZE = 50;
const COMPANY_WRITE_CONCURRENCY = 8;

type ProvisionalSource = "performance_report" | "performance_forecast";

type SyncCheckpoint = {
  reportDate: string;
  backfillNextPage: number;
  backfillComplete: boolean;
  latestPageFingerprint: string;
};

type SyncStats = {
  reportDate: string;
  pagesFetched: number;
  latestPagesChanged: number;
  latestPagesUnchanged: number;
  backfillPagesProcessed: number;
  rowsRead: number;
  companiesSeen: number;
  snapshotsUpdated: number;
  snapshotsInitialized: number;
  formalRowsProtected: number;
};

export async function syncProvisionalFinancialStatements(
  env: Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">,
  scheduledTime = Date.now()
): Promise<SyncStats> {
  const reportDate = latestCompletedQuarterEndDate(scheduledTime);
  const jobId = crypto.randomUUID();
  const startedAt = Date.now();
  await startSyncJob(env.DB, jobId, startedAt, reportDate);
  await migrateLegacyCheckpoints(env.DB, reportDate);
  const stats: SyncStats = {
    reportDate,
    pagesFetched: 0,
    latestPagesChanged: 0,
    latestPagesUnchanged: 0,
    backfillPagesProcessed: 0,
    rowsRead: 0,
    companiesSeen: 0,
    snapshotsUpdated: 0,
    snapshotsInitialized: 0,
    formalRowsProtected: 0,
  };
  try {
    await syncSource(env, "performance_report", reportDate, stats);
    await syncSource(env, "performance_forecast", reportDate, stats);
    await finishSyncJob(env.DB, jobId, "succeeded", stats, null);
    console.log("provisional financial statement sync completed", stats);
    return stats;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishSyncJob(env.DB, jobId, "failed", stats, message);
    throw err;
  }
}

async function syncSource(
  env: Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">,
  source: ProvisionalSource,
  reportDate: string,
  stats: SyncStats
): Promise<void> {
  const checkpoint = await readSyncCheckpoint(env.DB, source, reportDate);
  const firstPage = await fetchSourcePage(env.DB, source, reportDate, 1);
  const latestPageFingerprint = await sourcePageFingerprint(firstPage.rows);
  const latestPageChanged = checkpoint.latestPageFingerprint !== latestPageFingerprint;
  const pages = latestPageChanged ? [firstPage] : [];
  stats[latestPageChanged ? "latestPagesChanged" : "latestPagesUnchanged"] += 1;
  stats.pagesFetched += 1;
  let backfillNextPage = checkpoint.backfillNextPage;
  let backfillComplete = checkpoint.backfillComplete || firstPage.pages <= 1;
  if (!backfillComplete && firstPage.pages > 1) {
    const pageNumber = normalizeBackfillPage(backfillNextPage, firstPage.pages);
    if (pageNumber > 1) {
      pages.push(await fetchSourcePage(env.DB, source, reportDate, pageNumber));
      stats.pagesFetched += 1;
      stats.backfillPagesProcessed += 1;
    }
    backfillComplete = pageNumber >= firstPage.pages;
    backfillNextPage = backfillComplete ? pageNumber : pageNumber + 1;
  }
  const rows = dedupeSourceRows(pages.flatMap((page) => page.rows), source);
  stats.rowsRead += rows.length;
  const rowsByCode = groupRowsByCode(rows);
  stats.companiesSeen += rowsByCode.size;
  const entries = [...rowsByCode.entries()];
  for (let offset = 0; offset < entries.length; offset += COMPANY_WRITE_CONCURRENCY) {
    await Promise.all(entries.slice(offset, offset + COMPANY_WRITE_CONCURRENCY).map(async ([code, companyRows]) => {
      const snapshot = await getFinancialStatementsSnapshot(env, code, "income");
      const existingRows = ensureFinancialSourceMetadata(snapshot?.rows ?? []);
      const existingQuarter = existingRows.find((row) => row.reportDate === reportDate);
      if (financialDataSource(existingQuarter) === "financial_report") {
        stats.formalRowsProtected += 1;
        return;
      }
      const provisionalData = mergeStoredProvisionalData(snapshot?.provisionalData, source, reportDate, companyRows);
      const merged = mergeProvisionalFinancialStatements(
        existingRows,
        provisionalData.performanceRows,
        provisionalData.forecastRows
      );
      const mergedQuarter = merged.find((row) => row.reportDate === reportDate);
      const rowsToStore = mergedQuarter ? merged : existingRows;
      await putFinancialStatementsSnapshot(env, code, "income", rowsToStore, { provisionalData });
      if (!snapshot) stats.snapshotsInitialized += 1;
      stats.snapshotsUpdated += 1;
    }));
  }
  await writeSyncCheckpoint(env.DB, source, reportDate, {
    reportDate,
    backfillNextPage,
    backfillComplete,
    latestPageFingerprint,
  });
}

function mergeStoredProvisionalData(
  existing: FinancialProvisionalData | undefined,
  source: ProvisionalSource,
  reportDate: string,
  incoming: Record<string, unknown>[]
): FinancialProvisionalData {
  const current = existing?.reportDate === reportDate
    ? existing
    : { reportDate, performanceRows: [], forecastRows: [], updatedAt: 0 };
  return {
    reportDate,
    performanceRows: source === "performance_report"
      ? mergeRawSourceRows(current.performanceRows, incoming, source)
      : current.performanceRows,
    forecastRows: source === "performance_forecast"
      ? mergeRawSourceRows(current.forecastRows, incoming, source)
      : current.forecastRows,
    updatedAt: Date.now(),
  };
}

function mergeRawSourceRows(
  existing: Record<string, unknown>[],
  incoming: Record<string, unknown>[],
  source: ProvisionalSource
): Record<string, unknown>[] {
  return dedupeSourceRows([...incoming, ...existing], source);
}

function fetchSourcePage(
  db: D1Database,
  source: ProvisionalSource,
  reportDate: string,
  pageNumber: number
): Promise<EastmoneyDataPage> {
  return source === "performance_report"
    ? fetchEastmoneyPerformanceReportPage(db, reportDate, pageNumber, PAGE_SIZE)
    : fetchEastmoneyPerformanceForecastPage(db, reportDate, pageNumber, PAGE_SIZE);
}

function groupRowsByCode(rows: Record<string, unknown>[]): Map<string, Record<string, unknown>[]> {
  const result = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const code = normalizeSecurityCode(String(row.SECUCODE ?? row.SECURITY_CODE ?? ""));
    if (!/\.(SH|SZ|BJ)$/.test(code)) continue;
    const items = result.get(code) ?? [];
    items.push(row);
    result.set(code, items);
  }
  return result;
}

function dedupeSourceRows(
  rows: Record<string, unknown>[],
  source: ProvisionalSource
): Record<string, unknown>[] {
  const result = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (source === "performance_forecast" && String(row.IS_LATEST ?? "T") === "F") continue;
    const key = source === "performance_report"
      ? String(row.SECUCODE ?? row.SECURITY_CODE ?? "")
      : `${String(row.SECUCODE ?? row.SECURITY_CODE ?? "")}:${String(row.PREDICT_FINANCE_CODE ?? "")}`;
    if (!result.has(key)) result.set(key, row);
  }
  return [...result.values()];
}

function financialDataSource(row: FinancialStatement | undefined): unknown {
  const payload = row?.payload;
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>).dataSource
    : undefined;
}

async function readSyncCheckpoint(
  db: D1Database,
  source: ProvisionalSource,
  reportDate: string
): Promise<SyncCheckpoint> {
  const record = await getAppKv(db, cursorKey(source));
  if (!record) return emptyCheckpoint(reportDate);
  try {
    const value = JSON.parse(record.valueJson) as Record<string, unknown>;
    if (value.reportDate !== reportDate) return emptyCheckpoint(reportDate);
    const page = Number(value.backfillNextPage ?? value.nextPage);
    return {
      reportDate,
      backfillNextPage: Number.isInteger(page) && page >= 2 ? page : 2,
      backfillComplete: value.backfillComplete === true,
      latestPageFingerprint: typeof value.latestPageFingerprint === "string"
        ? value.latestPageFingerprint
        : "",
    };
  } catch {
    return emptyCheckpoint(reportDate);
  }
}

async function writeSyncCheckpoint(
  db: D1Database,
  source: ProvisionalSource,
  reportDate: string,
  checkpoint: SyncCheckpoint
): Promise<void> {
  await putAppKv(db, {
    key: cursorKey(source),
    valueJson: JSON.stringify(checkpoint),
    expiresAt: null,
    updatedAt: Date.now(),
  });
}

function emptyCheckpoint(reportDate: string): SyncCheckpoint {
  return { reportDate, backfillNextPage: 2, backfillComplete: false, latestPageFingerprint: "" };
}

function normalizeBackfillPage(nextPage: number, pages: number): number {
  return Number.isInteger(nextPage) && nextPage >= 2 && nextPage <= pages ? nextPage : 2;
}

async function sourcePageFingerprint(rows: Record<string, unknown>[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(rows));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function cursorKey(source: ProvisionalSource): string {
  return `financial-provisional-sync:${source}`;
}

async function migrateLegacyCheckpoints(db: D1Database, reportDate: string): Promise<void> {
  for (const source of ["performance_report", "performance_forecast"] as const) {
    const fixedKey = cursorKey(source);
    const fixed = await getAppKv(db, fixedKey);
    if (!fixed) {
      const legacy = await getAppKv(db, `${fixedKey}:${reportDate}`);
      if (legacy) {
        try {
          const value = JSON.parse(legacy.valueJson) as Record<string, unknown>;
          const page = Number(value.backfillNextPage ?? value.nextPage);
          await putAppKv(db, {
            key: fixedKey,
            valueJson: JSON.stringify({
              reportDate,
              backfillNextPage: Number.isInteger(page) && page >= 2 ? page : 2,
              backfillComplete: value.backfillComplete === true,
              latestPageFingerprint: typeof value.latestPageFingerprint === "string"
                ? value.latestPageFingerprint
                : "",
            } satisfies SyncCheckpoint),
            expiresAt: null,
            updatedAt: Date.now(),
          });
        } catch (err) {
          console.warn(`invalid legacy financial sync checkpoint: ${fixedKey}:${reportDate}`, err);
        }
      }
    }
  }
  await db.prepare(
    `delete from app_kv where key like 'financial-provisional-sync:%:%'`
  ).run();
}

async function startSyncJob(
  db: D1Database,
  jobId: string,
  startedAt: number,
  reportDate: string
): Promise<void> {
  await db.prepare(
    `insert into sync_jobs (job_id, job_type, status, started_at, stats_json)
     values (?, 'financial-provisional', 'running', ?, ?)`
  ).bind(jobId, startedAt, JSON.stringify({ reportDate })).run();
}

async function finishSyncJob(
  db: D1Database,
  jobId: string,
  status: "succeeded" | "failed",
  stats: SyncStats,
  error: string | null
): Promise<void> {
  await db.prepare(
    `update sync_jobs
     set status = ?, finished_at = ?, error = ?, stats_json = ?
     where job_id = ?`
  ).bind(status, Date.now(), error, JSON.stringify(stats), jobId).run();
}
