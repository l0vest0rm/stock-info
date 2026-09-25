import test from 'node:test';
import assert from 'node:assert/strict';
import { feedCompanyCandidates } from './information-feed-company-candidates.mjs';

test('Latin company aliases match case-insensitively', () => {
  assert.deepEqual(feedCompanyCandidates([{ alias: 'meta', code: 'META.US', name: 'Meta Platforms' }],
    '投行上调 Meta 目标价', ''), [{ tagId: 'company:META.US', name: 'Meta Platforms', matchedAlias: 'meta' }]);
});

test('company candidates prefer a full alias and ignore bare numeric coincidences', () => {
  const aliases = [
    { alias: '000716', code: '000716.SZ', name: '黑芝麻' },
    { alias: '传音', code: '688036.SH', name: '传音控股' },
    { alias: '传音控股', code: '688036.SH', name: '传音控股' },
  ];
  assert.deepEqual(feedCompanyCandidates(aliases, '传音控股股价上涨', '成交 000716 万元'),
    [{ tagId: 'company:688036.SH', name: '传音控股', matchedAlias: '传音控股' }]);
});

test('verified foreign-company code collisions are excluded without hiding another issuer', () => {
  const aliases = [
    { alias: '三星电子', code: '005930.SZ', name: '三星电子' },
    { alias: '真实A股公司', code: '005930.SZ', name: '真实A股公司' },
  ];
  assert.deepEqual(feedCompanyCandidates(aliases, '三星电子与真实A股公司', '', {
    excludedMappings: [{ code: '005930.SZ', name: '三星电子' }],
  }), [{ tagId: 'company:005930.SZ', name: '真实A股公司', matchedAlias: '真实A股公司' }]);
});
