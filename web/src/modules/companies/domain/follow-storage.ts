const FOLLOW_STORAGE_KEY = 'follow'

export function readFollowedCompanyCodes(): string[] {
  const stored = localStorage.getItem(FOLLOW_STORAGE_KEY) || ''
  return [...new Set(stored.split(',').map((code) => code.trim()).filter(Boolean))]
}

export function isCompanyFollowed(code: string): boolean {
  return readFollowedCompanyCodes().includes(code)
}

export function addFollowedCompany(code: string): void {
  const normalizedCode = code.trim()
  if (!normalizedCode) return
  const codes = readFollowedCompanyCodes()
  if (!codes.includes(normalizedCode)) {
    codes.push(normalizedCode)
    localStorage.setItem(FOLLOW_STORAGE_KEY, codes.join(','))
  }
}

export function removeFollowedCompany(code: string): void {
  const normalizedCode = code.trim()
  localStorage.setItem(FOLLOW_STORAGE_KEY, readFollowedCompanyCodes()
    .filter((item) => item !== normalizedCode)
    .join(','))
}

export function toggleFollowedCompany(code: string): boolean {
  if (isCompanyFollowed(code)) {
    removeFollowedCompany(code)
    return false
  }
  addFollowedCompany(code)
  return true
}
