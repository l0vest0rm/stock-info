import assert from 'node:assert/strict'
import test from 'node:test'
import { createCompanyReportController, type CompanyReportContext } from './company-pages-runtime'
import type { CompanyReportStatePatch } from './company-report-contract'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function browserHarness() {
  const original = new Map(['window', 'document', 'EventSource'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const timers = new Map<number, () => void>()
  let sequence = 0
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    setTimeout: (callback: () => void) => { timers.set(++sequence, callback); return sequence },
    clearTimeout: (id: number) => timers.delete(id),
    addEventListener() {}, removeEventListener() {},
  } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: () => null } })
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: undefined })
  return {
    timers,
    restore() {
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    },
  }
}

function context(fetchRequest: CompanyReportContext['fetchRequest']): CompanyReportContext {
  return {
    server: '', fetchRequest, fetchCodeNames: (_codes, callback) => callback({}),
    fetchFinanceIncome: (_code, callback) => callback(undefined),
    toDateString: () => '2026-09-08', getCode: () => '600519.SH',
    getCache: () => ({}), getCodeNameMap: () => ({ '600519.SH': '贵州茅台' }), echarts: {},
  }
}

test('report controller starts once and ignores late capability and report responses after disposal', async () => {
  const browser = browserHarness()
  try {
    const capability = deferred<unknown>()
    const reports = deferred<unknown>()
    const patches: CompanyReportStatePatch[] = []
    let reportRequests = 0
    const controller = createCompanyReportController(context(async (request) => {
      if (typeof request === 'string') { reportRequests += 1; return reports.promise }
      return capability.promise
    }), (patch) => patches.push(patch))
    await controller.start()
    await controller.start()
    assert.equal(reportRequests, 1)
    controller.dispose()
    controller.dispose()
    const patchCount = patches.length
    reports.resolve([{ title: 'late result' }])
    capability.resolve({ enabled: true, task: { name: 'queued-task', status: 'queued' } })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(patches.length, patchCount)
    assert.equal(browser.timers.size, 0)
    controller.changePage(2)
    assert.equal(reportRequests, 1)
  } finally { browser.restore() }
})

test('a slower previous page cannot replace the latest report page', async () => {
  const browser = browserHarness()
  try {
    const pending: Array<ReturnType<typeof deferred<unknown>>> = []
    const patches: CompanyReportStatePatch[] = []
    const controller = createCompanyReportController(context(async (request) => {
      if (typeof request !== 'string') return { enabled: false }
      const result = deferred<unknown>()
      pending.push(result)
      return result.promise
    }), (patch) => patches.push(patch))
    await controller.start()
    controller.changePage(2)
    pending[1].resolve([{ title: 'new page', publishDate: '2026-09-08' }])
    await new Promise<void>((resolve) => setImmediate(resolve))
    pending[0].resolve([{ title: 'old page', publishDate: '2026-09-07' }])
    await new Promise<void>((resolve) => setImmediate(resolve))
    const rendered = patches.filter((patch) => patch.rows?.length)
    assert.equal(rendered.length, 1)
    assert.equal(rendered[0].currentPage, 2)
    assert.equal(rendered[0].rows?.[0].title, 'new page')
    controller.dispose()
  } finally { browser.restore() }
})
