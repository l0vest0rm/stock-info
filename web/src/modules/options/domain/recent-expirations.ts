const EXPIRATION_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function rememberRecentExpiration(existing: string[], value: string, limit = 10): string[] {
  if (!EXPIRATION_PATTERN.test(value)) return existing
  return [value, ...existing.filter((item) => item !== value && EXPIRATION_PATTERN.test(item))].slice(0, limit)
}
