import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { legacyEntryFileName, pagesWithoutLegacyRuntime } from './page-build-config.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const webRoot = path.resolve(__dirname, '..')
const srcDir = path.join(webRoot, 'src')
const partialsDir = path.join(srcDir, 'partials')
const configDir = path.join(srcDir, 'config')
const distDir = path.join(webRoot, 'dist')
const staticDir = path.join(webRoot, 'static')

const includePattern = /<!--\s*@include:([a-zA-Z0-9_-]+)\s*-->/g

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return {}
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function loadBaseConfig() {
  return {
    ...loadJson(path.join(configDir, 'common.json')),
    ...loadJson(path.join(configDir, 'navigation.json')),
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttribute(value) {
  return escapeHtml(value)
}

function loadPartialSources() {
  const partials = new Map()
  for (const item of fs.readdirSync(partialsDir, { withFileTypes: true })) {
    if (!item.isFile() || path.extname(item.name) !== '.html') {
      continue
    }
    const name = path.basename(item.name, '.html')
    partials.set(name, fs.readFileSync(path.join(partialsDir, item.name), 'utf8'))
  }
  partials.set('companies_filter', renderCompaniesFilterPartial())
  return partials
}

function renderCompaniesFilterPartial() {
  const groups = loadJson(path.join(configDir, 'companies-filter-options.json'))
  if (!Array.isArray(groups)) {
    return ''
  }
  const lines = ['<select id="companiesFilter" class="d-none" multiple>']
  for (const group of groups) {
    lines.push(`    <optgroup label="${escapeHtml(group.label || '')}">`)
    const options = Array.isArray(group.options) ? group.options : []
    for (const option of options) {
      lines.push(`    <option value='${escapeHtml(option.value || '')}'>${escapeHtml(option.label || '')}</option>`)
    }
    lines.push('    </optgroup>')
  }
  lines.push('</select>')
  return lines.join('\n')
}

function normalizePathname(pathname) {
  const raw = String(pathname || '').trim()
  if (!raw || raw === '/') {
    return '/'
  }
  return raw.startsWith('/') ? raw : `/${raw}`
}

function pageUrl(config) {
  const siteUrl = String(config.siteUrl || '').replace(/\/+$/, '')
  const pathname = normalizePathname(config.canonicalPath || config.page)
  return `${siteUrl}${pathname === '/' ? '' : pathname}`
}

function defaultDescription(config) {
  const title = String(config.title || config.siteName || '').trim()
  const fallback = String(config.defaultDescription || '').trim()
  if (!title) {
    return fallback
  }
  if (!fallback) {
    return title
  }
  return `${title}，${fallback}`
}

function robotsContent(config) {
  if (config.noindex) {
    return 'noindex, nofollow'
  }
  return 'index, follow'
}

function renderMetaTags(config) {
  const title = String(config.title || '')
  const description = String(config.description || defaultDescription(config))
  const canonical = pageUrl(config)
  const imageUrl = config.imagePath ? `${String(config.siteUrl || '').replace(/\/+$/, '')}${normalizePathname(config.imagePath)}` : ''
  const robots = robotsContent(config)
  const keywords = String(config.keywords || '').trim()
  const lines = [
    '    <meta name="theme-color" content="#0b3b2e">',
    `    <meta name="description" content="${escapeAttribute(description)}">`,
    `    <meta name="robots" content="${escapeAttribute(robots)}">`,
    `    <link rel="canonical" href="${escapeAttribute(canonical)}">`,
    '    <link rel="icon" type="image/svg+xml" href="/favicon.svg">',
    '    <link rel="manifest" href="/site.webmanifest">',
    '    <meta property="og:type" content="website">',
    `    <meta property="og:site_name" content="${escapeAttribute(String(config.siteName || ''))}">`,
    `    <meta property="og:title" content="${escapeAttribute(title)}">`,
    `    <meta property="og:description" content="${escapeAttribute(description)}">`,
    `    <meta property="og:url" content="${escapeAttribute(canonical)}">`,
    '    <meta name="twitter:card" content="summary_large_image">',
    `    <meta name="twitter:title" content="${escapeAttribute(title)}">`,
    `    <meta name="twitter:description" content="${escapeAttribute(description)}">`,
  ]
  if (keywords) {
    lines.splice(3, 0, `    <meta name="keywords" content="${escapeAttribute(keywords)}">`)
  }
  if (imageUrl) {
    lines.push(`    <meta property="og:image" content="${escapeAttribute(imageUrl)}">`)
    lines.push(`    <meta name="twitter:image" content="${escapeAttribute(imageUrl)}">`)
  }
  return lines.join('\n')
}

function renderStructuredData(config) {
  const items = Array.isArray(config.structuredData)
    ? config.structuredData
    : config.structuredData
      ? [config.structuredData]
      : []
  if (items.length === 0) {
    return ''
  }
  return items
    .map((item) => `    <script type="application/ld+json">${JSON.stringify(item)}</script>`)
    .join('\n')
}

function renderIncludes(source, partials, stack = []) {
  return source.replace(includePattern, (matched, includeName) => {
    const partial = partials.get(includeName)
    if (typeof partial !== 'string') {
      throw new Error(`Missing partial: ${includeName}`)
    }
    if (stack.includes(includeName)) {
      throw new Error(`Circular include: ${[...stack, includeName].join(' -> ')}`)
    }
    return renderIncludes(partial, partials, [...stack, includeName])
  })
}

function renderPageTemplate(source, config, partials) {
  return renderIncludes(source, partials)
    .replaceAll('__TITLE__', String(config.title || ''))
    .replaceAll('__PAGE__', String(config.page || ''))
    .replaceAll('__META_TAGS__', renderMetaTags(config))
    .replaceAll('__STRUCTURED_DATA__', renderStructuredData(config))
    .replaceAll('__LEGACY_RUNTIME_BLOCK__', config.legacyRuntime === false ? '' : legacyRuntimeBlock(path.basename(String(config.page || ''), '.html')))
}

function compilePage(fileName, baseConfig, partials) {
  const basename = path.basename(fileName, '.html')
  const pageConfig = loadJson(path.join(configDir, `${basename}.json`))
  const config = {
    ...baseConfig,
    title: basename,
    page: `${basename}.html`,
    legacyRuntime: !pagesWithoutLegacyRuntime.has(basename),
    ...pageConfig,
  }
  const srcPath = path.join(srcDir, fileName)
  const template = fs.readFileSync(srcPath, 'utf8')
  fs.writeFileSync(path.join(distDir, `${basename}.html`), renderPageTemplate(template, config, partials))
  return {
    basename,
    config,
    srcPath,
  }
}

function legacyRuntimeBlock(pageBase) {
  return [
    `  <script type="module" src="${legacyEntryFileName(pageBase)}"></script>`,
  ].join('\n')
}

function cleanupRemovedPages(expectedPages) {
  for (const item of fs.readdirSync(distDir, { withFileTypes: true })) {
    if (!item.isFile() || path.extname(item.name) !== '.html') {
      continue
    }
    const basename = path.basename(item.name, '.html')
    if (!expectedPages.has(basename)) {
      fs.rmSync(path.join(distDir, item.name), { force: true })
    }
  }
}

function copyStaticAssets() {
  if (!fs.existsSync(staticDir)) {
    return
  }
  copyDir(staticDir, distDir)
}

function copyDir(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true })
  for (const item of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, item.name)
    const targetPath = path.join(targetDir, item.name)
    if (item.isDirectory()) {
      copyDir(sourcePath, targetPath)
      continue
    }
    if (!item.isFile()) {
      continue
    }
    fs.copyFileSync(sourcePath, targetPath)
  }
}

function generateRobots(baseConfig) {
  const siteUrl = String(baseConfig.siteUrl || '').replace(/\/+$/, '')
  const lines = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /knowledge-config.html',
    'Disallow: /company-option.html',
    `Sitemap: ${siteUrl}/sitemap.xml`,
    '',
  ]
  fs.writeFileSync(path.join(distDir, 'robots.txt'), lines.join('\n'))
}

function generateSitemap(compiledPages) {
  const urls = compiledPages
    .filter((page) => page.config.includeInSitemap === true && !page.config.noindex)
    .map((page) => {
      const stat = fs.statSync(page.srcPath)
      return {
        loc: pageUrl(page.config),
        lastmod: stat.mtime.toISOString(),
      }
    })
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((item) => [
      '  <url>',
      `    <loc>${escapeHtml(item.loc)}</loc>`,
      `    <lastmod>${item.lastmod}</lastmod>`,
      '  </url>',
    ].join('\n')),
    '</urlset>',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(distDir, 'sitemap.xml'), xml)
}

fs.mkdirSync(distDir, { recursive: true })

const baseConfig = loadBaseConfig()
const partials = loadPartialSources()
const pageFiles = fs.readdirSync(srcDir, { withFileTypes: true }).filter((item) => item.isFile() && path.extname(item.name) === '.html')
const expectedPages = new Set(pageFiles.map((item) => path.basename(item.name, '.html')))

cleanupRemovedPages(expectedPages)
copyStaticAssets()
const compiledPages = []
for (const item of pageFiles) {
  compiledPages.push(compilePage(item.name, baseConfig, partials))
}
generateRobots(baseConfig)
generateSitemap(compiledPages)
