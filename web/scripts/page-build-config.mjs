import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const pageManifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../config/page-manifest.json', import.meta.url)), 'utf8'))
const paths = new Set()
for (const page of pageManifest) {
  if (!/^\/[a-z0-9-]+\.html$/.test(page.path) || paths.has(page.path)) throw new Error(`Invalid or duplicate page path: ${page.path}`)
  if (!['all', 'local'].includes(page.runtime) || typeof page.legacy !== 'boolean') throw new Error(`Invalid page policy: ${page.path}`)
  if (page.entry !== null && !/^src\/modules\/[a-z0-9/-]+-page\.ts$/.test(page.entry)) throw new Error(`Invalid page entry: ${page.path}`)
  paths.add(page.path)
}
export const buildRuntime = process.env.WEB_RUNTIME || 'local'
if (!['local', 'production'].includes(buildRuntime)) throw new Error(`Invalid WEB_RUNTIME: ${buildRuntime}`)
export const buildPages = pageManifest.filter((page) => buildRuntime === 'local' || page.runtime === 'all')
export const pagesWithoutLegacyRuntime = new Set(pageManifest.filter((page) => !page.legacy).map((page) => page.path.slice(1, -5)))
export function legacyEntryFileName(pageBase) { return `js/legacy-pages/${pageBase}-legacy.js` }
