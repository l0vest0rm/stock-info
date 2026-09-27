import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendRejectedFeed, readRejectedFeed } from './information-feed-rejection-audit.mjs';

test('local audit keeps title and URL and supports review filters without database rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-rejected-'));
  try {
    const file = join(dir, 'rejected.jsonl');
    appendRejectedFeed({ title: '篮球比赛夺冠', url: 'https://example.test/sport', sourceKey: 'cls_telegraph',
      sourceItemId: 'one', reasonCodes: ['whitelist_miss'], bodySha256: 'a', policyVersion: 'v5' }, file);
    appendRejectedFeed({ title: '熊猫出访', url: 'https://example.test/panda', sourceKey: 'tencent_stock_news',
      sourceItemId: 'two', reasonCodes: ['whitelist_miss'], bodySha256: 'b', policyVersion: 'v5' }, file);
    appendRejectedFeed({ title: '篮球比赛夺冠', url: 'https://example.test/sport', sourceKey: 'cls_telegraph',
      sourceItemId: 'one', reasonCodes: ['whitelist_miss'], bodySha256: 'a', policyVersion: 'v5' }, file);
    const first = readRejectedFeed({ limit: 1 }, file, 'v5');
    assert.equal(first.total, 2);
    assert.equal(first.list[0].url, 'https://example.test/sport');
    assert.equal(first.next_offset, 1);
    assert.equal(readRejectedFeed({ q: '熊猫', source: 'tencent_stock_news' }, file, 'v5').list[0].title, '熊猫出访');
    assert.equal(readRejectedFeed({ reason: 'quote_only' }, file, 'v5').total, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
