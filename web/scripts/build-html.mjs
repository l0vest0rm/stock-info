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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
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
  const template = fs.readFileSync(path.join(srcDir, fileName), 'utf8')
  fs.writeFileSync(path.join(distDir, `${basename}.html`), renderPageTemplate(template, config, partials))
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

fs.mkdirSync(distDir, { recursive: true })

const baseConfig = loadBaseConfig()
const partials = loadPartialSources()
const pageFiles = fs.readdirSync(srcDir, { withFileTypes: true }).filter((item) => item.isFile() && path.extname(item.name) === '.html')
const expectedPages = new Set(pageFiles.map((item) => path.basename(item.name, '.html')))

cleanupRemovedPages(expectedPages)
for (const item of pageFiles) {
  compilePage(item.name, baseConfig, partials)
}
