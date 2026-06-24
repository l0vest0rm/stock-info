export function findInsertIndex(arr: number[], val: number): number {
  let low = 0
  let high = arr.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (arr[mid] < val) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  return low
}

export function findTsIndex(kline: number[][], ts: number): number {
  let low = 0
  let high = kline.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (kline[mid][0] < ts) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  if (low < kline.length && kline[low][0] === ts) {
    return low
  }
  return low - 1
}
