export const pagesWithoutLegacyRuntime = new Set([
  'home',
  'invest',
  'login',
  'macro',
  'situation',
  'situation-holdings',
  'situation-opportunities',
  'situation-evidence',
  'institutional-tracks',
])

export function legacyEntryFileName(pageBase) {
  return `js/legacy-pages/${pageBase}-legacy.js`
}
