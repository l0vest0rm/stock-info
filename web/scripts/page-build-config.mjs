export const pagesWithoutLegacyRuntime = new Set([
  'home',
  'invest',
  'login',
])

export function legacyEntryFileName(pageBase) {
  return `js/legacy-pages/${pageBase}-legacy.js`
}
