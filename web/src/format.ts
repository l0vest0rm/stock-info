export function queryString(obj: Record<string, unknown>): string {
  return Object.keys(obj).map((key) => `${key}=${encodeURIComponent(String(obj[key] || ''))}`).join('&')
}

export function formatReportNumber(n: number | string, isPercent: boolean): string {
  if (n === '-') {
    return n
  }
  if (typeof n === 'string') {
    n = parseFloat(n)
  }
  if (isPercent) {
    return (n * 100).toFixed(2)
  }
  if (n >= 1e11 || n <= -1e11) {
    return (n / 1e8).toFixed(0)
  }
  if (n >= 1e10 || n <= -1e10) {
    return (n / 1e8).toFixed(1)
  }
  if (n >= 1e9 || n <= -1e9) {
    return (n / 1e8).toFixed(2)
  }
  if (n >= 1e8 || n <= -1e8) {
    return (n / 1e8).toFixed(3)
  }
  if (n >= 1e4 || n <= -1e4) {
    return (n / 1e8).toFixed(4)
  }
  return n.toFixed(2)
}

export function hash(str: string, seed: number = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0, ch; i < str.length; i += 1) {
    ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
