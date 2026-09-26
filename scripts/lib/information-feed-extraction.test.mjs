import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { companyTagsForRecords, feedCategoryCatalog, feedCategoryCatalogHash, parseFeedExtraction } from './information-feed-extraction.mjs';
import { INFORMATION_FEED_DOCUMENT_ANALYSIS_USER_PROMPT } from '../generated/prompt-text.mjs';

const record = { entity: '平安银行', informationType: 'fact', category: 'revenue', period: '2026H1',
  statement: '平安银行2026年上半年营收同比增长。', forecastMeasurement: null };
const source = '星云云服务发生持续两小时的服务中断，部分客户无法使用在线业务。';
const candidate = { entity: '星云云服务', informationType: 'event', statement: '星云云服务发生持续两小时的服务中断。',
  suggestedCategory: '服务中断', evidence: '星云云服务发生持续两小时的服务中断', whyNotExisting: '产品研发描述开发进展，不涵盖在线服务故障。' };
const extraction = (records = [], categoryCandidates = []) => JSON.stringify({ records, categoryCandidates });

test('feed has one complete user prompt with both output arrays', () => {
  assert.match(INFORMATION_FEED_DOCUMENT_ANALYSIS_USER_PROMPT, /"records":\[.*"categoryCandidates":\[/);
  assert.match(INFORMATION_FEED_DOCUMENT_ANALYSIS_USER_PROMPT, /\{\{CATEGORY_CATALOG\}\}/);
  assert.match(INFORMATION_FEED_DOCUMENT_ANALYSIS_USER_PROMPT, /\{\{CONTENT\}\}/);
  assert.doesNotMatch(INFORMATION_FEED_DOCUMENT_ANALYSIS_USER_PROMPT, /替代上文|覆盖上文/);
});

test('feed extraction uses the feed category contract', () => {
  assert.match(feedCategoryCatalog(), /revenue: fact\|guidance\|forecast；period=required/);
  assert.deepEqual(parseFeedExtraction(extraction([record]), source), { records: [record], categoryCandidates: [] });
  assert.deepEqual(parseFeedExtraction(extraction(), source), { records: [], categoryCandidates: [] });
  assert.throws(() => parseFeedExtraction(extraction([{ ...record, period: null }]), source), /invalid feed record fields/);
  assert.throws(() => parseFeedExtraction(extraction([{ ...record, category: 'made_up' }]), source), /invalid feed record fields/);
  assert.throws(() => parseFeedExtraction(extraction([record, record, record, record]), source), /invalid feed extraction response/);
  assert.throws(() => parseFeedExtraction('{"records":[]}', source), /invalid feed extraction response/);
});

test('candidate categories preserve evidence but never become controlled records', () => {
  assert.deepEqual(parseFeedExtraction(extraction([], [candidate]), source), { records: [], categoryCandidates: [candidate] });
  assert.deepEqual(parseFeedExtraction(extraction([record], [candidate]), source), { records: [record], categoryCandidates: [candidate] });
  assert.throws(() => parseFeedExtraction(extraction([], [{ ...candidate, evidence: '正文中没有的服务故障证据' }]), source), /invalid feed category candidate fields/);
  assert.throws(() => parseFeedExtraction(extraction([], [{ ...candidate, suggestedCategory: '产品研发' }]), source), /invalid feed category candidate fields/);
  assert.throws(() => parseFeedExtraction(extraction([record, record, record], [candidate]), source), /invalid feed extraction response/);
  assert.throws(() => parseFeedExtraction(extraction([record], [{ ...candidate, entity: record.entity, statement: record.statement }]), source), /duplicates a record/);
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
  assert.deepEqual(parseFeedExtraction(extraction([forecast]), source).records[0].forecastMeasurement, forecast.forecastMeasurement);
  assert.equal(parseFeedExtraction(extraction([{ ...forecast, period: '2026FY' }]), source).records[0].forecastMeasurement, null);
});

test('only an unambiguous extracted entity gets a company tag', () => {
  const candidates = [
    { tagId: 'company:000001.SZ', name: '平安银行', matchedAlias: '平安银行股份有限公司' },
    { tagId: 'company:000716.SZ', name: '黑芝麻', matchedAlias: '黑芝麻' },
  ];
  assert.deepEqual(companyTagsForRecords([record, { ...record, entity: '黑芝麻智能' }], candidates), ['company:000001.SZ']);
  assert.deepEqual(companyTagsForRecords([record], [...candidates, { tagId: 'company:other', name: '平安银行' }]), []);
});
