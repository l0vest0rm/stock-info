import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const taxonomy = JSON.parse(readFileSync(new URL('../../config/information-feed-topics.json', import.meta.url), 'utf8'));

test('feed topics are distinct, industry-mapped subjects rather than event categories', () => {
  assert.match(taxonomy.version, /^feed-topics-v\d+$/);
  assert(taxonomy.topics.length > 0);
  const ids = new Set();
  const labels = new Set();
  for (const topic of taxonomy.topics) {
    assert.match(topic.id, /^[a-z][a-z0-9_]*$/);
    assert(topic.label?.trim());
    assert(!ids.has(topic.id), `duplicate topic ID: ${topic.id}`);
    assert(!labels.has(topic.label), `duplicate topic label: ${topic.label}`);
    assert(Array.isArray(topic.industryIds) && topic.industryIds.length > 0, `${topic.id} is not industry-mapped`);
    ids.add(topic.id);
    labels.add(topic.label);
  }
  for (const eventId of ['earnings', 'orders', 'capacity_expansion', 'price_cycle', 'dividend_buyback',
    'monetary_policy', 'fiscal_policy', 'geopolitics_supply_chain']) {
    assert(!ids.has(eventId), `${eventId} is not a fine-grained topic`);
  }
});
