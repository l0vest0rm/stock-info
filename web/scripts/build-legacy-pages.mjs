import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, defineConfig } from 'vite'
import { legacyEntryFileName, pagesWithoutLegacyRuntime } from './page-build-config.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const webRoot = path.resolve(__dirname, '..')
const srcDir = path.join(webRoot, 'src')
const distDir = path.join(webRoot, 'dist')
const distJsDir = path.join(distDir, 'js')
const tempEntriesDir = path.join(webRoot, '.vite-legacy-pages')

function listLegacyPages() {
  return fs.readdirSync(srcDir, { withFileTypes: true })
    .filter((item) => item.isFile() && path.extname(item.name) === '.html')
    .map((item) => path.basename(item.name, '.html'))
    .filter((page) => !pagesWithoutLegacyRuntime.has(page))
    .sort()
}

function cleanupLegacyOutputs(legacyPages) {
  const expectedFiles = new Set(legacyPages.map((page) => path.basename(legacyEntryFileName(page))))
  const legacyPagesDir = path.join(distJsDir, 'legacy-pages')
  const legacySharedDir = path.join(distJsDir, 'legacy-shared')
  if (fs.existsSync(legacyPagesDir)) {
    for (const item of fs.readdirSync(legacyPagesDir, { withFileTypes: true })) {
      if (!item.isFile()) {
        continue
      }
      if (!expectedFiles.has(item.name)) {
        fs.rmSync(path.join(legacyPagesDir, item.name), { force: true })
      }
    }
  }
  if (fs.existsSync(legacySharedDir)) {
    fs.rmSync(legacySharedDir, { recursive: true, force: true })
  }
  for (const fileName of ['legacy-page-init.js', 'legacy-page-init.js.map']) {
    const filePath = path.join(distJsDir, fileName)
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true })
    }
  }
}

function createTempEntries(legacyPages) {
  fs.rmSync(tempEntriesDir, { recursive: true, force: true })
  fs.mkdirSync(tempEntriesDir, { recursive: true })
  const legacyInitPath = path.join(srcDir, 'legacy-page-init.ts')
  const entries = {}
  for (const page of legacyPages) {
    const entryName = `${page}-legacy`
    const entryPath = path.join(tempEntriesDir, `${entryName}.ts`)
    let importPath = path.relative(tempEntriesDir, legacyInitPath).replaceAll(path.sep, '/')
    if (!importPath.startsWith('.')) {
      importPath = `./${importPath}`
    }
    fs.writeFileSync(entryPath, `import { runLegacyPageInit } from '${importPath}'\nrunLegacyPageInit('${page}.html')\n`)
    entries[entryName] = entryPath
  }
  return entries
}

function removeTempDir() {
  fs.rmSync(tempEntriesDir, { recursive: true, force: true })
}

const legacyPages = listLegacyPages()
cleanupLegacyOutputs(legacyPages)
const entries = createTempEntries(legacyPages)

try {
  await build(defineConfig({
    configFile: false,
    publicDir: false,
    build: {
      emptyOutDir: false,
      outDir: distDir,
      sourcemap: true,
      target: 'es2017',
      rollupOptions: {
        input: entries,
        output: {
          format: 'es',
          entryFileNames: (chunkInfo) => legacyEntryFileName(chunkInfo.name.replace(/-legacy$/, '')),
          chunkFileNames: 'js/legacy-shared/[name].js',
        },
      },
    },
  }))
} finally {
  removeTempDir()
}
