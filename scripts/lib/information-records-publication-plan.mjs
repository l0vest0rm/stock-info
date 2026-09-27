// Read-only preview for the new storage. Deliberately performs no remote calls.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withInformationDatabase, assertInformationSchema, readDocumentSnapshot } from './information-records-store.mjs';
import { publicationEligible, publicationFingerprint } from './information-records-publish.mjs';
import { FEED_EXTRACTION_CONTRACT } from '../generated/information-records-contract.mjs';

export function informationPublicationPlan(options = {}) {
  const root = resolve(new URL('../..', import.meta.url).pathname);
  const config = JSON.parse(readFileSync(resolve(root,'config/knowledge/information-feed.json'),'utf8'));
  const categories = new Set(Object.keys(JSON.parse(readFileSync(resolve(root,'config/knowledge/knowledge-ontology.json'),'utf8')).informationExtraction.categories));
  return withInformationDatabase(options, (db) => {
    assertInformationSchema(db);
    const snapshots = db.prepare("SELECT doc_id FROM knowledge_docs WHERE source_type='information_feed' ORDER BY sort_time,doc_id").all()
      .map(({doc_id}) => readDocumentSnapshot(db,doc_id));
    const latest = new Map();
    for (const snapshot of snapshots) latest.set(snapshot.meta.feed?.storyKey || snapshot.doc_id,snapshot);
    let eligible = 0, remove = 0;
    for (const snapshot of snapshots) {
      const valid = publicationEligible(snapshot,FEED_EXTRACTION_CONTRACT,config.remotePublication || {},categories);
      if (!valid && snapshot.meta.feed?.publishedFingerprint) { remove += 1; continue; }
      if (valid && latest.get(snapshot.meta.feed?.storyKey || snapshot.doc_id) === snapshot
        && snapshot.meta.feed.publishedFingerprint !== publicationFingerprint(snapshot)) eligible += 1;
    }
    return {dryRun:true,eligible,remove,remoteCalls:0,applyBlocked:true,
      reason:'remote publication execution integration and D1/Worker verification are pending'};
  },false);
}
