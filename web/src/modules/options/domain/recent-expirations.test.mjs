import assert from 'node:assert/strict'
import test from 'node:test'
import { rememberRecentExpiration } from './recent-expirations.ts'

test('keeps ten newest distinct expiration choices', () => {
  const initial = Array.from({ length: 10 }, (_, index) => `2026-09-${String(index + 1).padStart(2, '0')}`)
  assert.deepEqual(rememberRecentExpiration(initial, '2026-10-17'), [
    '2026-10-17',
    ...initial.slice(0, 9),
  ])
  assert.deepEqual(rememberRecentExpiration(initial, '2026-09-03').slice(0, 3), ['2026-09-03', '2026-09-01', '2026-09-02'])
})

test('ignores incomplete date input', () => {
  assert.deepEqual(rememberRecentExpiration(['2026-09-18'], '2026-09'), ['2026-09-18'])
})
