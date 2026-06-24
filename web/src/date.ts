export function zeroPad(num: number, places: number): string {
  return String(num).padStart(places, '0')
}

export function toDateString(ts: number | Date): string {
  let date: Date
  if (ts instanceof Date) {
    date = ts
  } else {
    date = new Date(ts < 4300000000 ? ts * 1000 : ts)
  }
  return `${date.getFullYear()}-${zeroPad(date.getMonth() + 1, 2)}-${zeroPad(date.getDate(), 2)}`
}

export function toTimeString(ts: number): string {
  const date = new Date(ts < 4300000000 ? ts * 1000 : ts)
  return `${date.getFullYear()}-${zeroPad(date.getMonth() + 1, 2)}-${zeroPad(date.getDate(), 2)} ${zeroPad(date.getHours(), 2)}:${zeroPad(date.getMinutes(), 2)}:${zeroPad(date.getSeconds(), 2)}`
}

export function toTimestamp(str: string): number {
  const normalized = str.replace(/[-/]/g, '')
  const date = new Date(
    parseInt(normalized.substring(0, 4)),
    parseInt(normalized.substring(4, 6)) - 1,
    parseInt(normalized.substring(6, 8)),
  )
  return date.getTime() + 8 * 3600 * 1000
}
