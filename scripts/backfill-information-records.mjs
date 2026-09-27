#!/usr/bin/env node

// Offline, local-only migration. No model calls and no remote requests.
import { mkdirSync, readFileSync, writeFileSync, openSync, writeSync, fsyncSync, closeSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { LEGACY_FEED_EXTRACTION_CONTRACT } from './generated/information-records-contract.mjs';
import { INFORMATION_STORAGE_VERSION, canonicalJson } from '../src/modules/knowledge/domain/information-records.ts';
import { openInformationDatabase, inTransaction, readDocument, readDocumentSnapshot, readInformationRows,
  clearLegacyFeedExtraction, sha } from './lib/information-records-store.mjs';
import { planInformationBackfill, applyInformationBackfill, readInformationBody, snapshotIdentity } from './lib/information-records-backfill.mjs';

const options = { apply: false, database: '', docId: '', report: '', archiveDir: '', contentDir: undefined, quarantine: false };
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === '--apply') options.apply = true;
  else if (arg === '--dry-run') options.apply = false;
  else if (arg === '--quarantine-invalid') options.quarantine = true;
  else if (arg === '--help') {
    console.log('Usage: node scripts/backfill-information-records.mjs [--apply] [--database PATH] [--doc-id ID] [--content-dir PATH] [--archive-dir PATH] [--report PATH] [--quarantine-invalid]\nDefaults to read-only dry-run. Apply requires the new schema. Originals are archived before every change; malformed JSON is only removed with explicit --quarantine-invalid.');
    process.exit(0);
  } else {
    const key = { '--database': 'database', '--doc-id': 'docId', '--report': 'report', '--archive-dir': 'archiveDir', '--content-dir': 'contentDir' }[arg];
    if (!key || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`invalid backfill argument: ${arg}`);
    options[key] = process.argv[++index];
  }
}
const root = resolve(new URL('..', import.meta.url).pathname);
const feedConfig = JSON.parse(readFileSync(join(root, 'config/knowledge/information-feed.json'), 'utf8'));
const db = openInformationDatabase({ root, ...(options.database ? { path: options.database } : {}) }, !options.apply);
const newSchema = db.prepare('PRAGMA table_info(knowledge_information_records)').all().some((column) => column.name === 'doc_id');
if (options.apply && !newSchema) { db.close(); throw new Error('apply migration 0142 before backfilling; preflight without --apply is supported on the old schema'); }
const archiveDir = resolve(options.archiveDir || join(root, 'data/local/information-records-archives'));
const result = { dryRun: !options.apply, schema: newSchema ? INFORMATION_STORAGE_VERSION : 'legacy',
  scanned: 0, changed: 0, unchanged: 0, records: 0, verified: 0, unverified: 0, quarantined: 0, errors: [], issueCounts: {}, archiveDir: options.apply ? archiveDir : null };
const aliases = db.prepare(`SELECT s.short_name AS alias,s.code,s.short_name AS name FROM stock s
  UNION ALL SELECT a.alias,a.code,s.short_name AS name FROM stock_alias a JOIN stock s ON s.code=a.code`).all();
const ids = db.prepare(`SELECT doc_id FROM knowledge_docs WHERE
  (source_type='information_feed' OR json_type(metadata_json,'$.informationExtraction') IS NOT NULL
  ${newSchema ? '' : 'OR EXISTS (SELECT 1 FROM knowledge_document_results x WHERE x.version_id=knowledge_docs.doc_id)'})
  ${options.docId ? 'AND doc_id=?' : ''} ORDER BY doc_id`).all(...(options.docId ? [options.docId] : []));
try {
  for (const { doc_id: docId } of ids) {
    result.scanned += 1;
    try {
      const snapshot = inTransaction(db, () => {
        if (newSchema) return readDocumentSnapshot(db, docId);
        const row = readDocument(db, docId);
        return { ...row, records: db.prepare(`SELECT r.information_id,x.version_id AS doc_id,r.entity,NULL AS entity_key,
          r.information_type,r.category,r.period,r.statement,r.forecast_measurement_json,r.sort_order,r.created_at
          FROM knowledge_information_records r JOIN knowledge_document_results x ON x.result_id=r.result_id WHERE x.version_id=? ORDER BY r.sort_order`).all(docId),
          tags: db.prepare('SELECT * FROM knowledge_doc_tags WHERE doc_id=? ORDER BY tag').all(docId) };
      }, false);
      const body = readInformationBody(snapshot.content_key, options.contentDir);
      let plan;
      try {
        plan = planInformationBackfill(snapshot, { body, aliases, contract: LEGACY_FEED_EXTRACTION_CONTRACT, companyPolicy: feedConfig.companyCandidates });
      } catch (error) {
        // Conflicting sources/active writers must never be overridden by quarantine.
        if (!options.quarantine || /conflicting|active legacy|changed/.test(String(error.message))) throw error;
        const meta = structuredClone(snapshot.meta);
        clearLegacyFeedExtraction(meta);
        meta.informationExtraction = { ...(meta.informationExtraction || {}), storageVersion: INFORMATION_STORAGE_VERSION,
          status: 'failed', current: meta.informationExtraction?.current || null, categoryCandidates: null,
          migrationIssues: [String(error.message)], lastAttempt: { error: 'malformed legacy extraction quarantined; see local archive', attempts: 0 } };
        plan = { kind: 'quarantine', meta, records: snapshot.records, issues: [String(error.message)] };
      }
      if (plan.kind === 'unchanged') { result.unchanged += 1; continue; }
      for (const issue of plan.issues) result.issueCounts[issue] = (result.issueCounts[issue] || 0) + 1;
      if (options.apply) {
        archive(snapshot);
        inTransaction(db, () => applyInformationBackfill(db, snapshot, plan));
      }
      result.changed += 1;
      result.records += plan.records.length;
      if (plan.kind === 'quarantine') result.quarantined += 1;
      else if (plan.meta.informationExtraction?.current?.provenanceStatus === 'verified') result.verified += 1;
      else if (plan.meta.informationExtraction?.current) result.unverified += 1;
    } catch (error) { result.errors.push({ docId, error: String(error.message || error) }); }
  }
  if (newSchema) {
    result.foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
    if (result.foreignKeyViolations.length) result.errors.push({ error: 'foreign key check failed' });
  }
} finally { db.close(); }
if (options.report) {
  const file = resolve(options.report); mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
}
console.log(JSON.stringify(result, null, 2));
if (result.errors.length) process.exitCode = 1;

function archive(snapshot) {
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const text = canonicalJson({ snapshot }) + '\n';
  const file = join(archiveDir, `${sha(snapshot.doc_id)}-${snapshotIdentity(snapshot)}.json`);
  if (!existsSync(file)) {
    const fd = openSync(file, 'wx', 0o600);
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  }
  if (sha(readFileSync(file)) !== sha(text)) throw new Error('backfill archive verification failed');
}
