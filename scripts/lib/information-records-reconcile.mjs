import { withInformationDatabase, readDocumentSnapshot, readDocument, writeMetadata } from './information-records-store.mjs';

export function hasRetainedExtraction(row) {
  const meta = row.meta || JSON.parse(row.metadata_json || '{}');
  return Number(row.record_count || row.records?.length || 0) > 0
    || !!meta.informationExtraction?.current
    || (meta.informationExtraction?.categoryCandidates?.length || 0) > 0
    || Object.hasOwn(meta.feed || {}, 'records')
    || meta.feed?.taggingStatus === 'complete';
}

// Only unextracted duplicate documents are eligible for physical deletion.
// All scan expectations are rechecked in one write transaction before any change.
export function reconcileUnextractedPairs(pairs, options = {}) {
  return withInformationDatabase(options, (db) => {
    const drops = new Set(pairs.map(({ drop }) => drop.doc_id));
    if (drops.size !== pairs.length || pairs.some(({ keep }) => drops.has(keep.doc_id))) throw new Error('invalid cyclic or repeated reconciliation pairs');
    for (const { keep, drop } of pairs) {
      for (const expected of [keep, drop]) {
        const actual = readDocumentSnapshot(db, expected.doc_id);
        for (const key of ['title','published_at','fetched_at','content_key','content_sha256','metadata_json']) {
          if (actual[key] !== expected[key]) throw new Error(`reconciliation input changed: ${expected.doc_id}`);
        }
        if (actual.source_type !== 'information_feed' || actual.meta.feed?.publishedFingerprint || actual.meta.feed?.publishAllowed) {
          throw new Error('published or non-feed documents require coordinated reconciliation');
        }
        if (expected.doc_id === drop.doc_id && hasRetainedExtraction(actual)) throw new Error('reconciliation cannot delete extracted information');
      }
    }
    for (const { keep, drop } of pairs) {
      const current = readDocument(db, keep.doc_id);
      const discarded = readDocument(db, drop.doc_id);
      const key = (item) => [item.sourceKey,item.sourceItemId,item.url,item.contentHash].join('|');
      const refs = new Map((current.meta.feed.sources || []).map((item) => [key(item), item]));
      for (const item of discarded.meta.feed.sources || []) refs.set(key(item), item);
      current.meta.feed.sources = [...refs.values()];
      writeMetadata(db, current);
      db.prepare('DELETE FROM knowledge_docs WHERE doc_id=?').run(drop.doc_id);
    }
    return pairs.length;
  });
}
