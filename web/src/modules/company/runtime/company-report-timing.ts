/** Durable task timestamps outrank a UI click/poll fallback. Never use updatedAt as the start. */
export function companyReportTimingStart(createdAt: number | null, startedAt: number | null, fallback: number | null): number | null {
  return startedAt ?? createdAt ?? fallback
}

export function companyReportElapsedSeconds(startAt: number | null, endAt: number | null): number | null {
  if (startAt === null || endAt === null || !Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt <= 0 || endAt < startAt) return null
  return Math.floor((endAt - startAt) / 1000)
}
