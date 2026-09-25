import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalFeedUrl, classifyFeedCandidate, classifyFeedItem, feedShingleSketch, sketchesOverlap } from './information-feed-dedupe.mjs';

const old = { sourceKey: 'cls', sourceItemId: '1', url: 'https://cls.cn/1', body: '甲公司公告。\n\n2026年收入10亿元。\n\n新产线已经投产。' };

test('canonical URL drops tracking but not identity', () => {
  assert.equal(canonicalFeedUrl('https://EXAMPLE.com/a?utm_source=x&id=2#z'), 'https://example.com/a?id=2');
  assert.equal(canonicalFeedUrl('http://gu.qq.com/resources/shy/news/detail-v2/index.html#/?id=nes1&s=b'),
    'http://gu.qq.com/resources/shy/news/detail-v2/index.html#/?id=nes1&s=b');
});
test('cross-source exact same body is repeat', () => {
  assert.equal(classifyFeedCandidate({ ...old, sourceKey: 'tencent', sourceItemId: '2' }, old).kind, 'repeat');
});
test('same URL with changed number is not swallowed', () => {
  assert.notEqual(classifyFeedCandidate({ ...old, body: old.body.replace('10亿元', '12亿元') }, old).kind, 'repeat');
});
test('short dispatch with changed numbers is not collapsed', () => {
  const a = { ...old, title: '甲公司收入情况', body: '甲公司预计收入10亿元。' };
  assert.equal(classifyFeedCandidate({ ...a, body: '甲公司实现收入12亿元。' }, a).kind, 'update');
});
test('cross-source long reports with conflicting amounts stay separate', () => {
  const body = '某上市公司发布年度业绩预告，公司表示本年度营业收入预计达到100亿元，同比增长百分之二十。该消息来自公司官方公告，涉及主营业务结构与市场规模变化，管理层强调未来仍会持续投入研发，进一步改善经营效率。关于业务结构，公司在多个地区推进销售渠道建设与客户服务体系升级，目前各条产品线运行正常，订单交付保持稳定。公司同时介绍了供应链管理和产品开发的具体安排，并表示会依据市场需求逐步调整产能规划。';
  const first = { sourceKey: 'cls', sourceItemId: '1', body };
  const second = { sourceKey: 'tencent', sourceItemId: '2', body: body.replace('100亿元', '120亿元') };
  assert.equal(classifyFeedCandidate(second, first).kind, 'new');
});
test('unrelated articles with shared tags remain separate', () => {
  assert.equal(classifyFeedItem({ ...old, body: '乙公司拟投资100亿元建设新工厂。' }, [old]).kind, 'new');
});
test('different source company codes prevent a near-text merge', () => {
  const body = '公司发布公告称本季度订单同比增长，正在扩大产能，预计明年继续推进海外业务。';
  assert.equal(classifyFeedCandidate({ ...old, body, entityCodes: ['SZ300308'] }, { ...old, body: body.replace('继续', '持续'), entityCodes: ['SZ300502'] }).kind, 'new');
});
test('same-source long report with an added paragraph is an update, not a repeat', () => {
  const a = { ...old, body: '甲公司发布年度经营数据，主营业务保持稳定。\n\n本季度新产品订单继续增长，海外业务同比提升。\n\n管理层介绍新增产能预计明年投入使用。\n\n公司表示现有订单交付正常。' };
  const b = { ...a, body: `${a.body}\n\n新产品已获得首批客户订单。` };
  assert.equal(classifyFeedCandidate(b, a).kind, 'update');
  assert.equal(sketchesOverlap(feedShingleSketch(a.body), feedShingleSketch(b.body)), true);
});
test('punctuation-only rewriting does not create another card', () => {
  const a = { ...old, body: '甲公司发布年度经营数据，主营业务保持稳定。本季度新产品订单继续增长，海外业务同比提升。管理层介绍新增产能预计明年投入使用。公司表示现有订单交付正常。' };
  const b = { ...a, body: a.body.replaceAll('，', ',') };
  assert.equal(classifyFeedCandidate(b, a).kind, 'repeat');
});
test('source attribution-only edits are a repeat', () => {
  const body = '9月16日消息，甲公司新品今日发布。\n\n新机搭载最新存储芯片。';
  const a = { ...old, body: `快科技${body}` };
  const b = { ...old, sourceKey: 'tencent', sourceItemId: '2', body: `${body}\n\n【来源:快科技】` };
  assert.equal(classifyFeedCandidate(b, a).kind, 'repeat');
});
test('short wire dateline does not duplicate otherwise identical information', () => {
  const body = '企查查APP显示,近日,长鑫芯聚股权投资(安徽)有限公司注册资本增加至61.84亿元。';
  const first = { ...old, body };
  const second = { ...old, sourceKey: 'tencent', sourceItemId: '2', body: `蓝鲸新闻9月16日电，${body}` };
  assert.equal(classifyFeedCandidate(second, first).kind, 'repeat');
});
test('source prefix and publisher footer do not make a second card', () => {
  const body = '9月16日,据路透社报道,韩国SK海力士正与英特尔洽谈一项交易,拟首次在美国本土生产存储芯片。消息人士称谈判尚属探索性,强调尚未作出决定。';
  const first = { ...old, body: `来源:金十数据\n\n${body}\n\n美股频道更多独家策划、专家专栏,免费查阅>>责任编辑:栎树` };
  const second = { ...old, sourceKey: 'tencent', sourceItemId: '2', body };
  assert.equal(classifyFeedCandidate(second, first).kind, 'repeat');
});
