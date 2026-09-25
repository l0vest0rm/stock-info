import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeedSource } from './information-feed-source.mjs';

test('CLS text enters the feed', () => {
  const item = normalizeFeedSource({ title: '标题', url: 'https://www.cls.cn/detail/123', markdown: '内容', metadata: { source: 'cls_telegraph', clsId: '123' } });
  assert.equal(item.accepted, true);
  assert.equal(item.sourceItemId, '123');
  assert.equal(item.contentType, 'flash');
});
test('Tencent Python-style content text is extracted', () => {
  const item = normalizeFeedSource({ id: '1', dedupe_title: '标题', title: '标题', content: "{'text': '<P>公司\\'新业务</P>'}" });
  assert.equal(item.accepted, true);
  assert.equal(item.body, "公司'新业务");
});
test('converted PDF is excluded even with Markdown', () => {
  const item = normalizeFeedSource({ url: 'https://x/a.pdf', accessMethod: 'markdown_from_remote_pdf', markdown: '正文', sourceKey: 'x' });
  assert.deepEqual(item, { accepted: false, reason: 'pdf_origin' });
});
test('unknown original format does not enter through converted Markdown', () => {
  assert.equal(normalizeFeedSource({ sourceKey: 'future', sourceItemId: 'a', accessMethod: 'markdown', markdown: '正文' }).reason, 'unknown_origin_format');
  assert.equal(normalizeFeedSource({ sourceKey: 'future', sourceItemId: 'a', originalMime: 'text/html', markdown: '正文' }).accepted, true);
  assert.equal(normalizeFeedSource({ sourceKey: 'future', sourceItemId: 'b', originalMime: 'text/html', content: '<p>正文</p>' }).body, '正文');
  assert.equal(normalizeFeedSource({ sourceKey: 'future', sourceItemId: 'c', originalMime: 'text/markdown', content: '# 正文' }).body, '# 正文');
});
test('Tencent report attachment excerpts do not bypass the PDF-origin gate', () => {
  const item = normalizeFeedSource({ id: '1', dedupe_title: '报告', content: { text: '<p>（以下内容从某券商《计算机周报》研报附件原文摘录）</p><p>报告文字</p>' } });
  assert.equal(item.reason, 'pdf_derived_excerpt');
});
