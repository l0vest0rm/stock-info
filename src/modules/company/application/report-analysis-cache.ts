const sharedReportAnalysisInFlight = new Map<string, Promise<void>>();
const SHARED_REPORT_ANALYSIS_CACHE_VERSION = "v7";

export function isReusableReportAnalysisCache(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.analysisCalled !== true || !Array.isArray(record.forecasts)) {
    return false;
  }
  return record.forecasts.length > 0 || record.analysisSucceeded === true;
}

export function eastmoneyReportInfoCode(...values: unknown[]): string {
  for (const value of values) {
    const match = String(value || "").toUpperCase().match(/AP\d{12,}/);
    if (match) {
      return match[0];
    }
  }
  return "";
}

export function sharedReportAnalysisCacheKey(infoCode: string): string {
  const normalized = eastmoneyReportInfoCode(infoCode);
  return normalized
    ? `shared-report-analysis:${SHARED_REPORT_ANALYSIS_CACHE_VERSION}:eastmoney:${normalized}`
    : "";
}

export async function runSharedReportAnalysisTask(
  cacheKey: string,
  task: () => Promise<void>,
): Promise<void> {
  if (!cacheKey) {
    await task();
    return;
  }
  const existing = sharedReportAnalysisInFlight.get(cacheKey);
  if (existing) {
    await existing;
    await runSharedReportAnalysisTask(cacheKey, task);
    return;
  }
  const pending = task().finally(() => sharedReportAnalysisInFlight.delete(cacheKey));
  sharedReportAnalysisInFlight.set(cacheKey, pending);
  await pending;
}
