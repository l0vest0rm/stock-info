import assert from 'node:assert/strict'
import test from 'node:test'
import { createLegacyDataServices } from './legacy-data-services'

test('retries a K-line request after a cached request failure', async () => {
  const cache: Record<string, unknown> = {}
  let requestCount = 0
  const services = createLegacyDataServices({
    cache,
    codeNameMap: {},
    klineCodes: [],
    markPoints: [],
    server: '',
    usCodeMap: {},
    fetchRequest: async (request) => {
      requestCount += 1
      const requestCacheKey = typeof request === 'object' ? request.cacheKey : undefined
      if (requestCount === 1) {
        const error = { error: 'temporary failure' }
        if (requestCacheKey) cache[requestCacheKey] = error
        return error
      }
      return [[Date.UTC(2026, 6, 30), 219.84]]
    },
  })

  assert.equal(await services.fetchKline('688525.SH', ''), undefined)
  assert.equal(cache['688525.SH::'], undefined)

  assert.deepEqual(
    await services.fetchKline('688525.SH', ''),
    [[Date.UTC(2026, 6, 30), 219.84]],
  )
  assert.equal(requestCount, 2)
})
