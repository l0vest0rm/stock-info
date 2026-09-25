import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('legacy knowledge importer cannot reintroduce untagged CLS/Tencent news', () => {
  const dir = mkdtempSync(join(tmpdir(), 'information-feed-legacy-'));
  try {
    const file = join(dir, 'news.jsonl');
    writeFileSync(file, JSON.stringify({ docId: 'x', title: '标题', metadata: { source: 'cls_telegraph' } }));
    const result = spawnSync(process.execPath, ['scripts/import-knowledge-docs.mjs', '--file', file], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /belongs to the information-feed pipeline/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
