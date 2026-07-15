export type SecuritySearchHistoryItem = {
  code: string
  market: string
  type: string
  name: string
}

type StoredSecuritySearchHistoryItem = {
  id: string
  name: string
}

const SEARCH_HISTORY_KEY = 'autocomplete-recentClick'
const SEARCH_HISTORY_LIMIT = 20

export function loadSecuritySearchHistory(): SecuritySearchHistoryItem[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizeStoredHistoryItem)
      .filter((item): item is SecuritySearchHistoryItem => Boolean(item))
      .slice(0, SEARCH_HISTORY_LIMIT)
  } catch (error) {
    console.warn('[security-search-history] failed to load history', error)
    return []
  }
}

export function rememberSecuritySearch(item: SecuritySearchHistoryItem): SecuritySearchHistoryItem[] {
  const normalized = normalizeSearchResult(item)
  if (!normalized) return loadSecuritySearchHistory()
  const history = [
    normalized,
    ...loadSecuritySearchHistory().filter((entry) => entry.code !== normalized.code),
  ].slice(0, SEARCH_HISTORY_LIMIT)
  try {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history.map(toStoredHistoryItem)))
  } catch (error) {
    console.warn('[security-search-history] failed to save history', error)
  }
  return history
}

function normalizeStoredHistoryItem(value: unknown): SecuritySearchHistoryItem | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Partial<StoredSecuritySearchHistoryItem>
  const code = String(row.id || '').trim()
  const name = String(row.name || '')
    .replace(new RegExp(`\\(${escapeRegExp(code)}\\)$`), '')
    .trim()
  if (!code || !name) return null
  return {
    code,
    name,
    market: '',
    type: '',
  }
}

function normalizeSearchResult(value: SecuritySearchHistoryItem): SecuritySearchHistoryItem | null {
  const code = String(value.code || '').trim()
  const name = String(value.name || '').trim()
  if (!code || !name) return null
  return {
    code,
    name,
    market: String(value.market || '').trim(),
    type: String(value.type || '').trim(),
  }
}

function toStoredHistoryItem(item: SecuritySearchHistoryItem) {
  return {
    id: item.code,
    name: `${item.name}(${item.code})`,
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
