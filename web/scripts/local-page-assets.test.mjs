import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { test } from 'node:test'
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
