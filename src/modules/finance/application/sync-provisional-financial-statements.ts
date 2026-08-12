import {
  fetchEastmoneyPerformanceForecastPage,
  fetchEastmoneyPerformanceReportPage,
  type EastmoneyDataPage,
} from "../../../adapters/eastmoney";
import { getKvCacheByLegacyKey, putKvCacheByLegacyKey } from "../../../db/queries";
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
const DISCLOSURE_DATE_OVERLAP_DAYS = 2;
const DEFAULT_BOOTSTRAP_PAGE_BATCH_SIZE = 25;

export type ProvisionalSource = "performance_report" | "performance_forecast";

type SourceConfig = {
  source: ProvisionalSource;
  disclosureDateFields: readonly string[];
  rowKey: (row: Record<string, unknown>) => string;
  acceptRow: (row: Record<string, unknown>) => boolean;
  fetchPage: (
    db: D1Database,
    reportDate: string,
    pageNumber: number,
    pageSize: number
  ) => Promise<EastmoneyDataPage>;
};

const SOURCE_CONFIGS: Record<ProvisionalSource, SourceConfig> = {
  performance_report: {
    source: "performance_report",
    disclosureDateFields: ["UPDATE_DATE", "NOTICE_DATE"],
    rowKey: (row) => String(row.SECUCODE ?? row.SECURITY_CODE ?? ""),
    acceptRow: () => true,
    fetchPage: fetchEastmoneyPerformanceReportPage,
  },
  performance_forecast: {
    source: "performance_forecast",
    disclosureDateFields: ["NOTICE_DATE", "UPDATE_DATE"],
    rowKey: (row) => `${String(row.SECUCODE ?? row.SECURITY_CODE ?? "")}:${String(row.PREDICT_FINANCE_CODE ?? "")}`,
    acceptRow: (row) => String(row.IS_LATEST ?? "T") !== "F",
    fetchPage: fetchEastmoneyPerformanceForecastPage,
  },
};

type SyncCheckpoint = {
  schemaVersion: 2;
  reportDate: string;
  bootstrapNextPage: number;
  bootstrapComplete: boolean;
  bootstrapMaxDisclosureDate: string | null;
  watermarkDate: string | null;
};

type SourceStats = {
  phase: "bootstrap" | "incremental";
  pagesFetched: number;
  bootstrapPagesProcessed: number;
  incrementalPagesProcessed: number;
  rowsRead: number;
  incrementalRowsRead: number;
  stopDate: string | null;
  watermarkBefore: string | null;
  watermarkAfter: string | null;
  watermarkAdvanced: boolean;
  bootstrapComplete: boolean;
};

export type SyncStats = {
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
  bootstrapPagesProcessed: number;
  incrementalPagesProcessed: number;
  incrementalRowsRead: number;
  incrementalCyclesCompleted: number;
  incrementalCyclesFailed: number;
  watermarksAdvanced: number;
  sourceStats: Record<ProvisionalSource, SourceStats>;
};

export type ProvisionalSyncOptions = {
  /** Test seam; production uses the source config's Eastmoney adapter. */
  fetchPage?: (
    source: ProvisionalSource,
    db: D1Database,
    reportDate: string,
    pageNumber: number,
    pageSize: number
  ) => Promise<EastmoneyDataPage>;
  /** A bounded bootstrap batch still resumes from the durable next page. */
  maxBootstrapPagesPerRun?: number;
};

export async function syncProvisionalFinancialStatements(
  env: Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">,
  scheduledTime = Date.now(),
  options: ProvisionalSyncOptions = {}
): Promise<SyncStats> {
  const reportDate = latestCompletedQuarterEndDate(scheduledTime);
  const jobId = crypto.randomUUID();
  const startedAt = Date.now();
  await startSyncJob(env.DB, jobId, startedAt, reportDate);
  await migrateLegacyCheckpoints(env.DB, reportDate);
  const stats = emptyStats(reportDate);
  try {
    await syncSource(env, SOURCE_CONFIGS.performance_report, reportDate, stats, options);
    await syncSource(env, SOURCE_CONFIGS.performance_forecast, reportDate, stats, options);
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
  config: SourceConfig,
  reportDate: string,
  stats: SyncStats,
  options: ProvisionalSyncOptions
): Promise<void> {
  let checkpoint = await readSyncCheckpoint(env.DB, config.source, reportDate);
  const sourceStats = stats.sourceStats[config.source];
  sourceStats.bootstrapComplete = checkpoint.bootstrapComplete;

  // A source becomes incremental only on the scheduled cycle after its full
  // bootstrap.  This keeps the bootstrap's durable page cursor unambiguous.
  if (!checkpoint.bootstrapComplete) {
    sourceStats.phase = "bootstrap";
    checkpoint = await bootstrapSource(env, config, checkpoint, reportDate, stats, options);
    sourceStats.bootstrapComplete = checkpoint.bootstrapComplete;
    return;
  }

  sourceStats.phase = "incremental";
  await incrementalSource(env, config, checkpoint, reportDate, stats, options);
}

async function bootstrapSource(
  env: Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">,
  config: SourceConfig,
  initialCheckpoint: SyncCheckpoint,
  reportDate: string,
  stats: SyncStats,
  options: ProvisionalSyncOptions
): Promise<SyncCheckpoint> {
  let checkpoint = initialCheckpoint;
  const sourceStats = stats.sourceStats[config.source];
  const maxPages = normalizePositiveInteger(options.maxBootstrapPagesPerRun, DEFAULT_BOOTSTRAP_PAGE_BATCH_SIZE);
  let pagesProcessedThisRun = 0;
  let totalPages = 1;

  // Page 1 is always fetched to obtain the current page count.  On a resumed
  // bootstrap it is metadata only; the durable cursor identifies the first
  // page whose rows still need processing.
  const firstPage = await fetchSourcePage(env.DB, config, reportDate, 1, options);
  recordPageFetched(stats, sourceStats);
  totalPages = normalizePageCount(firstPage.pages);
  let nextPage = normalizeBootstrapPage(checkpoint.bootstrapNextPage, totalPages);

  if (nextPage === 1) {
    await processSourceRows(env, config.source, reportDate, firstPage.rows, stats);
    recordBootstrapPageProcessed(stats, sourceStats);
    pagesProcessedThisRun += 1;
    checkpoint = {
      ...checkpoint,
      bootstrapNextPage: 2,
      bootstrapMaxDisclosureDate: maxDate(
        checkpoint.bootstrapMaxDisclosureDate,
        maxDisclosureDate(config, firstPage.rows)
      ),
    };
    await writeSyncCheckpoint(env.DB, config.source, reportDate, checkpoint);
    nextPage = 2;
  }

  while (nextPage <= totalPages && pagesProcessedThisRun < maxPages) {
    const page = await fetchSourcePage(env.DB, config, reportDate, nextPage, options);
    recordPageFetched(stats, sourceStats);
    totalPages = Math.max(totalPages, normalizePageCount(page.pages));
    await processSourceRows(env, config.source, reportDate, page.rows, stats);
    recordBootstrapPageProcessed(stats, sourceStats);
    pagesProcessedThisRun += 1;
    checkpoint = {
      ...checkpoint,
      bootstrapNextPage: nextPage + 1,
      bootstrapMaxDisclosureDate: maxDate(
        checkpoint.bootstrapMaxDisclosureDate,
        maxDisclosureDate(config, page.rows)
      ),
    };
    await writeSyncCheckpoint(env.DB, config.source, reportDate, checkpoint);
    nextPage += 1;
  }

  if (nextPage > totalPages) {
    checkpoint = {
      ...checkpoint,
      bootstrapNextPage: nextPage,
      bootstrapComplete: true,
      watermarkDate: checkpoint.bootstrapMaxDisclosureDate,
    };
    await writeSyncCheckpoint(env.DB, config.source, reportDate, checkpoint);
  }
  return checkpoint;
}

async function incrementalSource(
  env: Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">,
  config: SourceConfig,
  checkpoint: SyncCheckpoint,
  reportDate: string,
  stats: SyncStats,
  options: ProvisionalSyncOptions
): Promise<void> {
  const sourceStats = stats.sourceStats[config.source];
  const watermarkBefore = checkpoint.watermarkDate;
  const stopDate = watermarkBefore ? subtractDays(watermarkBefore, DISCLOSURE_DATE_OVERLAP_DAYS) : null;
  sourceStats.watermarkBefore = watermarkBefore;
  sourceStats.stopDate = stopDate;

  let pageNumber = 1;
  let totalPages = 1;
  let crossedWatermark = false;
  const rows: Record<string, unknown>[] = [];
  let newestDisclosureDate: string | null = null;

  while (pageNumber <= totalPages) {
    const page = await fetchSourcePage(env.DB, config, reportDate, pageNumber, options);
    recordPageFetched(stats, sourceStats);
    sourceStats.incrementalPagesProcessed += 1;
    stats.incrementalPagesProcessed += 1;
    totalPages = Math.max(totalPages, normalizePageCount(page.pages));
    const pageRows: Record<string, unknown>[] = [];
    let pageCrossed = false;
    for (const row of page.rows) {
      const disclosureDate = sourceDisclosureDate(config, row);
      if (disclosureDate && stopDate && disclosureDate < stopDate) {
        pageCrossed = true;
        continue;
      }
      pageRows.push(row);
      newestDisclosureDate = maxDate(newestDisclosureDate, disclosureDate);
    }
    rows.push(...pageRows);
    if (pageCrossed) {
      crossedWatermark = true;
      break;
    }
    if (page.rows.length === 0 || pageNumber >= totalPages) {
      crossedWatermark = true;
      break;
    }
    pageNumber += 1;
  }

  // If a bounded upstream response did not reach either the watermark
  // boundary or its final page, leave the old watermark intact.  The next
  // scheduled cycle starts again at page 1 and retries the complete scan.
  if (!crossedWatermark) {
    stats.incrementalCyclesFailed += 1;
    return;
  }

  await processSourceRows(env, config.source, reportDate, rows, stats);
  stats.incrementalRowsRead += rows.length;
  sourceStats.incrementalRowsRead += rows.length;
  const watermarkAfter = maxDate(watermarkBefore, newestDisclosureDate);
  const advanced = watermarkAfter !== watermarkBefore;
  await writeSyncCheckpoint(env.DB, config.source, reportDate, {
    ...checkpoint,
    watermarkDate: watermarkAfter,
  });
  sourceStats.watermarkAfter = watermarkAfter;
  sourceStats.watermarkAdvanced = advanced;
  if (advanced) stats.watermarksAdvanced += 1;
  stats.incrementalCyclesCompleted += 1;
}

async function processSourceRows(
  env: Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">,
  source: ProvisionalSource,
  reportDate: string,
  incomingRows: Record<string, unknown>[],
  stats: SyncStats
): Promise<void> {
  const rows = dedupeSourceRows(incomingRows, SOURCE_CONFIGS[source]);
  stats.rowsRead += rows.length;
  stats.sourceStats[source].rowsRead += rows.length;
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
}

function emptyStats(reportDate: string): SyncStats {
  return {
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
    bootstrapPagesProcessed: 0,
    incrementalPagesProcessed: 0,
    incrementalRowsRead: 0,
    incrementalCyclesCompleted: 0,
    incrementalCyclesFailed: 0,
    watermarksAdvanced: 0,
    sourceStats: {
      performance_report: emptySourceStats(),
      performance_forecast: emptySourceStats(),
    },
  };
}

function emptySourceStats(): SourceStats {
  return {
    phase: "bootstrap",
    pagesFetched: 0,
    bootstrapPagesProcessed: 0,
    incrementalPagesProcessed: 0,
    rowsRead: 0,
    incrementalRowsRead: 0,
    stopDate: null,
    watermarkBefore: null,
    watermarkAfter: null,
    watermarkAdvanced: false,
    bootstrapComplete: false,
  };
}

function recordPageFetched(stats: SyncStats, sourceStats: SourceStats): void {
  stats.pagesFetched += 1;
  sourceStats.pagesFetched += 1;
}

function recordBootstrapPageProcessed(stats: SyncStats, sourceStats: SourceStats): void {
  stats.bootstrapPagesProcessed += 1;
  stats.backfillPagesProcessed += 1;
  sourceStats.bootstrapPagesProcessed += 1;
}

function fetchSourcePage(
  db: D1Database,
  config: SourceConfig,
  reportDate: string,
  pageNumber: number,
  options: ProvisionalSyncOptions
): Promise<EastmoneyDataPage> {
  return options.fetchPage
    ? options.fetchPage(config.source, db, reportDate, pageNumber, PAGE_SIZE)
    : config.fetchPage(db, reportDate, pageNumber, PAGE_SIZE);
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

function dedupeSourceRows(rows: Record<string, unknown>[], config: SourceConfig): Record<string, unknown>[] {
  const result = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!config.acceptRow(row)) continue;
    const key = config.rowKey(row);
    if (!result.has(key)) result.set(key, row);
  }
  return [...result.values()];
}

function sourceDisclosureDate(config: SourceConfig, row: Record<string, unknown>): string {
  for (const field of config.disclosureDateFields) {
    const value = trimDate(row[field]);
    if (value) return value;
  }
  return "";
}

function maxDisclosureDate(config: SourceConfig, rows: Record<string, unknown>[]): string | null {
  return rows.reduce<string | null>((latest, row) => maxDate(latest, sourceDisclosureDate(config, row)), null);
}

function maxDate(left: string | null, right: string | null): string | null {
  if (!right) return left;
  if (!left || right > left) return right;
  return left;
}

function subtractDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function normalizePageCount(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function normalizeBootstrapPage(value: number, totalPages: number): number {
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, totalPages + 1);
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
      ? mergeRawSourceRows(current.performanceRows, incoming, SOURCE_CONFIGS.performance_report)
      : current.performanceRows,
    forecastRows: source === "performance_forecast"
      ? mergeRawSourceRows(current.forecastRows, incoming, SOURCE_CONFIGS.performance_forecast)
      : current.forecastRows,
    updatedAt: Date.now(),
  };
}

function mergeRawSourceRows(
  existing: Record<string, unknown>[],
  incoming: Record<string, unknown>[],
  config: SourceConfig
): Record<string, unknown>[] {
  return dedupeSourceRows([...incoming, ...existing], config);
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
  const record = await getKvCacheByLegacyKey(db, cursorKey(source, reportDate));
  if (!record) return emptyCheckpoint(reportDate);
  try {
    const value = JSON.parse(record.valueJson) as Record<string, unknown>;
    if (value.reportDate !== reportDate) return emptyCheckpoint(reportDate);
    const nextPage = Number(value.bootstrapNextPage ?? value.backfillNextPage ?? value.nextPage);
    return {
      schemaVersion: 2,
      reportDate,
      bootstrapNextPage: Number.isInteger(nextPage) && nextPage >= 1 ? nextPage : 1,
      bootstrapComplete: value.bootstrapComplete === true || value.backfillComplete === true,
      bootstrapMaxDisclosureDate: trimDate(value.bootstrapMaxDisclosureDate) || null,
      watermarkDate: trimDate(value.watermarkDate) || null,
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
  await putKvCacheByLegacyKey(db, {
    key: cursorKey(source, reportDate),
    valueJson: JSON.stringify(checkpoint),
    expiresAt: null,
    updatedAt: Date.now(),
  });
}

function emptyCheckpoint(reportDate: string): SyncCheckpoint {
  return {
    schemaVersion: 2,
    reportDate,
    bootstrapNextPage: 1,
    bootstrapComplete: false,
    bootstrapMaxDisclosureDate: null,
    watermarkDate: null,
  };
}

export function provisionalSyncStateKey(source: ProvisionalSource, reportDate: string): string {
  return `financial-provisional-sync:${source}:${reportDate}`;
}

function cursorKey(source: ProvisionalSource, reportDate: string): string {
  return provisionalSyncStateKey(source, reportDate);
}

async function migrateLegacyCheckpoints(db: D1Database, reportDate: string): Promise<void> {
  for (const source of ["performance_report", "performance_forecast"] as const) {
    const newKey = cursorKey(source, reportDate);
    if (await getKvCacheByLegacyKey(db, newKey)) continue;
    const legacyKey = `financial-provisional-sync:${source}`;
    const legacy = await getKvCacheByLegacyKey(db, legacyKey);
    if (!legacy) continue;
    try {
      const value = JSON.parse(legacy.valueJson) as Record<string, unknown>;
      if (value.reportDate !== reportDate) continue;
      await putKvCacheByLegacyKey(db, {
        key: newKey,
        valueJson: JSON.stringify({
          schemaVersion: 2,
          reportDate,
          bootstrapNextPage: Number(value.backfillNextPage ?? value.nextPage) || 1,
          bootstrapComplete: value.backfillComplete === true,
          bootstrapMaxDisclosureDate: null,
          watermarkDate: null,
        } satisfies SyncCheckpoint),
        expiresAt: null,
        updatedAt: Date.now(),
      });
    } catch (err) {
      console.warn(`invalid legacy financial sync checkpoint: ${legacyKey}`, err);
    }
  }
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

function trimDate(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 10) : "";
}
