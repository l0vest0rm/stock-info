import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import relevanceConfig from '../../config/information-feed-relevance.json' with { type: 'json' };

export function auditFilePath() {
  return resolve(process.env.INFORMATION_FEED_RELEVANCE_AUDIT_FILE || 'data/local/information-feed-relevance-rejected.jsonl');
}

export function appendRejectedFeed(entry, file = auditFilePath()) {
  mkdirSync(dirname(file), { recursive: true });
  const row = { sourceKey: entry.sourceKey || '', sourceItemId: entry.sourceItemId || '',
    url: entry.url || '', title: entry.title || '', publishedAt: entry.publishedAt || '',
    checkedAt: new Date().toISOString(), policyVersion: entry.policyVersion,
    reasonCodes: entry.reasonCodes || [], evidence: entry.evidence || [], bodySha256: entry.bodySha256 || '' };
  appendFileSync(file, JSON.stringify(row) + '\n');
}

export function readRejectedFeed(params, file = auditFilePath(), currentVersion = relevanceConfig.version) {
  const q = String(params.q || '').trim().toLocaleLowerCase().slice(0, 100);
  const source = String(params.source || '').trim().slice(0, 60);
  const reason = String(params.reason || '').trim().slice(0, 80);
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 30));
  const offset = Math.max(0, Number(params.offset) || 0);
  const seen = new Set();
  const list = [];
  const sources = new Map();
  const reasons = new Map();
  for (const path of [file]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').trim().split(/\r?\n/).reverse()) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.policyVersion !== currentVersion) continue;
      const key = [row.sourceKey, row.sourceItemId || row.url, row.bodySha256].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      sources.set(row.sourceKey || '', (sources.get(row.sourceKey || '') || 0) + 1);
      for (const code of row.reasonCodes || []) reasons.set(code, (reasons.get(code) || 0) + 1);
      if (q && !String(row.title || '').toLocaleLowerCase().includes(q)) continue;
      if (source && row.sourceKey !== source) continue;
      if (reason && !row.reasonCodes?.includes(reason)) continue;
      list.push(row);
    }
  }
  return { list: list.slice(offset, offset + limit), total: list.length,
    has_next: offset + limit < list.length, next_offset: offset + limit < list.length ? offset + limit : null,
    sources: [...sources].map(([id, count]) => ({ id, count })),
    reasons: [...reasons].map(([id, count]) => ({ id, count })) };
}
