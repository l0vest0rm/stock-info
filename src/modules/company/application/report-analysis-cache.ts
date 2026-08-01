const sharedReportAnalysisInFlight = new Map<string, Promise<void>>();

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
    ? `shared-report-analysis:eastmoney:${normalized}`
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
