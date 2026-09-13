import fs from 'node:fs'
import { resolve, basename, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, defineConfig } from 'vite'
import { buildPages, buildRuntime } from './page-build-config.mjs'

// One graph for layout, Vue pages and transitional legacy adapters means every
// browser page loads one Vue instance and one instance of shared services.
const webRoot = fileURLToPath(new URL('..', import.meta.url))
const dist = resolve(webRoot, 'dist')
const temporary = resolve(webRoot, '.vite-page-entries')
const jsDir = resolve(dist, 'js')
for (const directory of ['page-shared', 'legacy-shared', 'legacy-pages']) {
  fs.rmSync(resolve(jsDir, directory), { recursive: true, force: true })
}
if (fs.existsSync(jsDir)) {
  for (const item of fs.readdirSync(jsDir)) {
    if (/-page\.js(?:\.map)?$/.test(item) || /^layout\.js(?:\.map)?$/.test(item)) fs.rmSync(resolve(jsDir, item))
  }
}
fs.rmSync(temporary, { recursive: true, force: true })
fs.mkdirSync(temporary, { recursive: true })
function importPath(source) {
  return JSON.stringify('../' + relative(webRoot, resolve(webRoot, source)).split(sep).join('/'))
}
const input = { layout: resolve(webRoot, 'src/app/layout/index.ts') }
for (const page of buildPages) {
  const name = basename(page.path, '.html')
  if (page.entry) {
    const entryName = basename(page.entry, '.ts')
    const file = resolve(temporary, `${entryName}.ts`)
    fs.writeFileSync(file, `import ${importPath('src/app/layout/index.ts')}\nimport ${importPath(page.entry)}\n`)
    input[entryName] = file
  }
  if (page.legacy) {
    const entryName = `${name}-legacy`
    const file = resolve(temporary, `${entryName}.ts`)
    fs.writeFileSync(file, `import ${importPath('src/app/layout/index.ts')}\nimport { runLegacyPageInit } from ${importPath('src/legacy-page-init.ts')}\nrunLegacyPageInit(${JSON.stringify(page.path.slice(1))})\n`)
    input[entryName] = file
  }
}
try {
  await build(defineConfig({
    configFile: false,
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      __STOCK_INFO_LOCAL_PAGES__: JSON.stringify(buildRuntime === 'local'),
    },
    publicDir: false,
    build: {
      emptyOutDir: false,
      outDir: dist, sourcemap: true, target: 'es2017',
      rollupOptions: {
        input,
        output: {
          format: 'es',
          entryFileNames: (chunk) => chunk.name.endsWith('-legacy') ? 'js/legacy-pages/[name].js' : 'js/[name].js',
          chunkFileNames: 'js/page-shared/[name]-[hash].js',
        },
      },
    },
  }))
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
