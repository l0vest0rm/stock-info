import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dependencies = fileURLToPath(new URL('../../node_modules/', import.meta.url))
const assets = [
  ['bootstrap', 'dist/css/bootstrap.min.css', 'bootstrap.min.css'],
  ['bootstrap', 'dist/css/bootstrap.min.css.map', 'bootstrap.min.css.map'],
  ['bootstrap', 'dist/js/bootstrap.bundle.min.js', 'bootstrap.bundle.min.js'],
  ['bootstrap', 'dist/js/bootstrap.bundle.min.js.map', 'bootstrap.bundle.min.js.map'],
  ['bootstrap', 'LICENSE', 'LICENSE'],
  ['echarts', 'dist/echarts.min.js', 'echarts.min.js'],
  ['echarts', 'LICENSE', 'LICENSE'],
  ['echarts', 'NOTICE', 'NOTICE'],
  ['marked', 'lib/marked.umd.js', 'marked.umd.js'],
  ['marked', 'lib/marked.umd.js.map', 'marked.umd.js.map'],
  ['marked', 'LICENSE', 'LICENSE'],
]

/** UI libraries are installation dependencies, never runtime CDN requests. */
export function copyLocalPageAssets(dist) {
  for (const [name, source, target] of assets) {
    const destination = path.join(dist, 'vendor', name, target)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(path.join(dependencies, name, source), destination)
  }
}

/** Fail a complete web build rather than shipping missing or remote UI assets. */
export function verifyLocalPageAssets(dist) {
  let count = 0
  for (const name of fs.readdirSync(dist)) {
    if (!name.endsWith('.html')) continue
    const html = fs.readFileSync(path.join(dist, name), 'utf8')
    for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
      if (tag[0].startsWith('<link') && !/rel=["'](?:stylesheet|icon|manifest)["']/i.test(tag[0])) continue
      const reference = tag[0].match(/\b(?:src|href)=["']([^"']+)["']/i)?.[1]
      if (!reference) continue
      if (/^(?:https?:)?\/\//i.test(reference)) throw new Error(`Remote UI dependency in ${name}: ${reference}`)
      const relative = reference.split(/[?#]/, 1)[0].replace(/^\//, '')
      const asset = path.resolve(dist, relative)
      if (!asset.startsWith(path.resolve(dist) + path.sep) || !fs.statSync(asset, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Missing local UI dependency in ${name}: ${reference}`)
      }
      count++
    }
  }
  console.log(`Local page asset contract passed (${count} references; no runtime CDN dependencies).`)
}
