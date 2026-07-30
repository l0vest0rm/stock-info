export const pagesWithoutLegacyRuntime = new Set([
  'home',
  'invest',
  'login',
  'macro',
  'institutional-tracks',
])

export function legacyEntryFileName(pageBase) {
  return `js/legacy-pages/${pageBase}-legacy.js`
}
