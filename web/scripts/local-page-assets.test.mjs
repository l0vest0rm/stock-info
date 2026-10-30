import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import { fileURLToPath } from 'node:url'
import { validateContent } from '../src/modules/featured-reports/domain/content.ts'
import { copyLocalPageAssets, verifyLocalPageAssets } from './local-page-assets.mjs'

function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-info-local-assets-'))
  try { run(dir) } finally { fs.rmSync(dir, { force: true, recursive: true }) }
}

test('local vendor assets retain browser global APIs and library licenses', () => fixture(dir => {
  copyLocalPageAssets(dir)
  for (const name of ['bootstrap/LICENSE', 'echarts/LICENSE', 'echarts/NOTICE', 'marked/LICENSE']) {
    assert.ok(fs.statSync(path.join(dir, 'vendor', name)).size > 0)
  }
  const context = vm.createContext({ console, setTimeout, clearTimeout })
  vm.runInContext(fs.readFileSync(path.join(dir, 'vendor/echarts/echarts.min.js'), 'utf8'), context)
  vm.runInContext(fs.readFileSync(path.join(dir, 'vendor/marked/marked.umd.js'), 'utf8'), context)
  assert.match(context.echarts.version, /^6\./)
  assert.equal(typeof context.echarts.init, 'function')
  assert.equal(typeof context.echarts.dispose, 'function')
  assert.equal(typeof context.echarts.getInstanceByDom, 'function')
  assert.match(context.marked.parse('**local**'), /<strong>local<\/strong>/)
  fs.writeFileSync(path.join(dir, 'fixture.html'), '<link rel="stylesheet" href="/vendor/bootstrap/bootstrap.min.css"><script src="/vendor/echarts/echarts.min.js"></script>')
  verifyLocalPageAssets(dir)
}))

test('build contract fails remote, missing and escaping asset references', () => fixture(dir => {
  const page = path.join(dir, 'fixture.html')
  for (const source of [
    '<script src="https://cdn.example/library.js"></script>',
    '<link rel="stylesheet" href="//cdn.example/library.css">',
    '<script src="/missing.js"></script>',
    '<link rel="stylesheet" href="../private.css">',
  ]) {
    fs.writeFileSync(page, source)
    assert.throws(() => verifyLocalPageAssets(dir), /(?:Remote|Missing) .*dependency/)
  }
}))


test('browser and shared contracts never import the retired backend or Cloudflare', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const backend = path.resolve(root, 'src')
  function files(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? files(path.join(dir, entry.name)) : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : [])
  }
  for (const file of [...files(path.join(root, 'web/src')), ...files(path.join(root, 'shared'))]) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    function visit(node) {
      const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : null
      if (specifier && ts.isStringLiteralLike(specifier)) {
        const dependency = specifier.text
        assert.ok(!dependency.startsWith('@cloudflare/'), `Cloudflare import in ${file}: ${dependency}`)
        if (dependency.startsWith('.')) {
          const target = path.resolve(path.dirname(file), dependency)
          assert.ok(target !== backend && !target.startsWith(backend + path.sep), `Retired backend import in ${file}: ${dependency}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'config/app/page-manifest.json'), 'utf8'))
  for (const page of manifest) {
    if (!page.entry) continue
    const entry = path.resolve(root, 'web', page.entry)
    assert.ok(entry.startsWith(path.join(root, 'web/src') + path.sep), `Non-browser page entry: ${page.entry}`)
    assert.ok(fs.existsSync(entry), `Missing page entry: ${page.entry}`)
  }
})

test('browser report response validator preserves structural and PDF anchor safety', () => {
  const content = {
    schemaVersion: 1, reportId: 'a'.repeat(64), title: 'Fixture', institution: 'Research',
    reportDate: '2026-10-30', pageCount: 2, summary: 'Fixture summary',
    sections: [{ id: 'section-1', title: 'Risks', blocks: [{ id: 'block-1', translation: 'Conditional research', sourceLocations: [{ page: 2, bbox: [0.1, 0.2, 0.8, 0.9] }] }] }],
  }
  assert.equal(validateContent(content), content)
  const invalid = change => { const value = structuredClone(content); change(value); assert.throws(() => validateContent(value)) }
  invalid(value => { value.reportId = '../private' })
  invalid(value => { value.summary = '' })
  invalid(value => { value.sections[0].blocks[0].id = 'section-1' })
  invalid(value => { value.sections[0].blocks[0].sourceLocations[0].page = 3 })
  invalid(value => { value.sections[0].blocks[0].sourceLocations[0].bbox = [0.8, 0.2, 0.1, 0.9] })
  invalid(value => { value.sections[0].blocks[0].sourceLocations[0].bbox[0] = -0.1 })
})
