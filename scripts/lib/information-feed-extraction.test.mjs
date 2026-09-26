import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { companyTagsForRecords, feedCategoryCatalog, feedCategoryCatalogHash, parseFeedExtraction } from './information-feed-extraction.mjs';

const record = { entity: '平安银行', informationType: 'fact', category: 'revenue', period: '2026H1',
  statement: '平安银行2026年上半年营收同比增长。', forecastMeasurement: null };

test('feed extraction uses the existing information-processing category contract', () => {
  assert.match(feedCategoryCatalog(), /revenue: fact\|guidance\|forecast；period=required/);
  assert.deepEqual(parseFeedExtraction(JSON.stringify({ records: [record] })), [record]);
  assert.deepEqual(parseFeedExtraction('{"records":[]}'), []);
  assert.throws(() => parseFeedExtraction(JSON.stringify({ records: [{ ...record, period: null }] })), /invalid feed record fields/);
  assert.throws(() => parseFeedExtraction(JSON.stringify({ records: [{ ...record, category: 'made_up' }] })), /invalid feed record fields/);
  assert.throws(() => parseFeedExtraction(JSON.stringify({ records: [record, record, record, record] })), /invalid feed extraction response/);
});

test('Chinese display labels do not change the extraction contract or existing hash', () => {
  const raw = readFileSync(new URL('../../config/knowledge-ontology.json', import.meta.url), 'utf8');
  assert.equal(feedCategoryCatalogHash(), '31390c312c0ea91d28aeac6f4637f8af87cebdac0991c0b3af39e2e8c2b02cdb');
  assert.equal(feedCategoryCatalogHash(raw.replace('"label": "营收"', '"label": "收入"')), feedCategoryCatalogHash());
  assert.notEqual(feedCategoryCatalogHash(raw.replace('"periodPolicy": "required"', '"periodPolicy": "optional"')), feedCategoryCatalogHash());
  assert.doesNotMatch(feedCategoryCatalog(), /营收/);
});

test('incomplete measurement is null without discarding the record', () => {
  const forecast = { ...record, informationType: 'forecast', period: '2027FY', forecastMeasurement: {
    fiscalYear: 2027, rawValue: 10, rawUnit: 'billion_currency', currency: 'CNY', accountingBasis: 'gaap',
    ownershipBasis: 'consolidated', shareBasis: 'unspecified',
  } };
  assert.deepEqual(parseFeedExtraction(JSON.stringify({ records: [forecast] }))[0].forecastMeasurement, forecast.forecastMeasurement);
  assert.equal(parseFeedExtraction(JSON.stringify({ records: [{ ...forecast, period: '2026FY' }] }))[0].forecastMeasurement, null);
});

test('only an unambiguous extracted entity gets a company tag', () => {
  const candidates = [
    { tagId: 'company:000001.SZ', name: '平安银行', matchedAlias: '平安银行股份有限公司' },
    { tagId: 'company:000716.SZ', name: '黑芝麻', matchedAlias: '黑芝麻' },
  ];
  assert.deepEqual(companyTagsForRecords([record, { ...record, entity: '黑芝麻智能' }], candidates), ['company:000001.SZ']);
  assert.deepEqual(companyTagsForRecords([record], [...candidates, { tagId: 'company:other', name: '平安银行' }]), []);
});
