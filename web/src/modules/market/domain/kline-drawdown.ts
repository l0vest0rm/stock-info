export interface KlineDrawdownPoint<X extends string | number = string | number> {
  x: X
  high: number
  low: number
}

export interface KlineDrawdownSegment<X extends string | number = string | number> {
  peakX: X
  peak: number
  troughX: X
  trough: number
  percent: number
}

/**
 * Splits a price series into drawdown episodes. An episode starts at a running
 * high and ends when a later bar reaches that high again. Its marker points to
 * the lowest price reached before the recovery. The final, unrecovered episode
 * is included as well.
 */
export function calculateKlineDrawdowns<X extends string | number>(
  points: KlineDrawdownPoint<X>[],
): KlineDrawdownSegment<X>[] {
  const usablePoints = points.filter((point) => (
    Number.isFinite(point.high) && Number.isFinite(point.low) && point.high > 0 && point.low > 0
  ))
  if (usablePoints.length < 2) {
    return []
  }

  const segments: KlineDrawdownSegment<X>[] = []
  let peakX = usablePoints[0].x
  let peak = Math.max(usablePoints[0].high, usablePoints[0].low)
  let troughX: X | undefined
  let trough = Number.POSITIVE_INFINITY

  const finishEpisode = () => {
    if (troughX === undefined || trough >= peak) {
      return
    }
    segments.push({
      peakX,
      peak,
      troughX,
      trough,
      percent: 100 * (trough / peak - 1),
    })
  }

  for (let i = 1; i < usablePoints.length; i++) {
    const point = usablePoints[i]
    const high = Math.max(point.high, point.low)
    const low = Math.min(point.high, point.low)

    if (high >= peak) {
      finishEpisode()
      peakX = point.x
      peak = high
      troughX = undefined
      trough = Number.POSITIVE_INFINITY
      continue
    }

    if (low < trough) {
      troughX = point.x
      trough = low
    }
  }

  finishEpisode()
  return segments
}
