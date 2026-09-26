import test from 'node:test';
import assert from 'node:assert/strict';
import { isRecentFeedTime, recentFeedRows } from './information-feed-window.mjs';

const now = Date.parse('2026-09-26T01:00:00.000Z');

test('only timestamps within the latest 48 hours are eligible', () => {
  assert.equal(isRecentFeedTime('2026-09-24T01:00:00.000Z', now), true);
  assert.equal(isRecentFeedTime('2026-09-24T00:59:59.999Z', now), false);
  assert.equal(isRecentFeedTime('2026-09-26T01:00:00.001Z', now), false);
  assert.equal(isRecentFeedTime('', now), false);
});

test('eligible feed rows are processed newest first', () => {
  const rows = [
    { doc_id: 'old', sort_time: '2026-09-24T00:59:59.999Z' },
    { doc_id: 'a', sort_time: '2026-09-25T12:00:00.000Z' },
    { doc_id: 'new', sort_time: '2026-09-26T00:59:00.000Z' },
    { doc_id: 'b', sort_time: '2026-09-25T12:00:00.000Z' },
  ];
  assert.deepEqual(recentFeedRows(rows, now).map((row) => row.doc_id), ['new', 'b', 'a']);
});
