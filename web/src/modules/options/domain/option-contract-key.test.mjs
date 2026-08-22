import assert from 'node:assert/strict'
import test from 'node:test'
import { optionContractKey } from './option-contract-key.ts'

const call = { type: 'call', strike: 200, expiration: '2026-12-18', multiplier: 100 }

test('matches the same listed contract across buy and sell strategy legs', () => {
  assert.equal(optionContractKey('aapl.us', call), optionContractKey('AAPL.US', { ...call, side: 'sell', quantity: 3, premium: 8 }))
})

test('keeps different expirations and multipliers separate', () => {
  assert.notEqual(optionContractKey('AAPL.US', call), optionContractKey('AAPL.US', { ...call, expiration: '2027-01-15' }))
  assert.notEqual(optionContractKey('AAPL.US', call), optionContractKey('AAPL.US', { ...call, multiplier: 10 }))
})
