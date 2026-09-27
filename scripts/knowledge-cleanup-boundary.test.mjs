import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';

test('knowledge retention is independent of information records and preserves feed documents', () => {
  const source = readFileSync(new URL('./cleanup-knowledge-docs.mjs', import.meta.url), 'utf8');
  const db = new DatabaseSync(':memory:');
  try {
    // Deliberately no information-records table or extraction metadata.
    db.exec(`CREATE TABLE knowledge_docs (doc_id TEXT PRIMARY KEY,source_type TEXT,event_time TEXT,published_at TEXT,fetched_at TEXT);
      CREATE TABLE knowledge_doc_content_refs (doc_id TEXT);
      INSERT INTO knowledge_docs VALUES ('feed','information_feed','2000-01-01',NULL,NULL),('news','news','2000-01-01',NULL,NULL);
      INSERT INTO knowledge_doc_content_refs VALUES ('feed'),('news');`);
    const cleanup = runInNewContext(source.slice(source.indexOf('function cleanupKnowledgeDocs('), source.indexOf('function parseArgs(')) + '\ncleanupKnowledgeDocs', {
      querySingleInteger: sql => db.prepare(sql).get().count,
      executeSql: sql => db.exec(sql),
      sqlString: value => `'${value.replaceAll("'", "''")}'`,
    });
    const summary = cleanup({enabled:true,maxAgeDays:1,apply:true});
    assert.equal(summary.deletedDocs,1);
    assert.equal(summary.expiredContentRefs,1);
    assert.deepEqual(db.prepare('SELECT doc_id FROM knowledge_docs').all().map(row=>row.doc_id),['feed']);
  } finally { db.close(); }
});

test('general knowledge maintenance does not depend on news extraction storage', () => {
  for (const file of ['cleanup-knowledge-docs.mjs','filter-existing-knowledge-docs.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source,/knowledge_information_records|informationExtraction/);
    assert.match(source,/source_type\s*!=\s*'information_feed'/);
  }
});
