import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolveExistingLocalD1Database, LOCAL_SQLITE_BUSY_TIMEOUT_MS } from './local-d1-sqlite.mjs';
import { entityKeyForRecord, parseFeedExtraction } from './information-feed-extraction.mjs';
import {
  INFORMATION_STORAGE_VERSION, canonicalJson, rowToInformation, recordsDigestInput,
  contractMatches, extractionOutcome, tagsForInformationRows,
} from '../../src/modules/knowledge/domain/information-records.ts';

export const sha = (value) => createHash('sha256').update(value).digest('hex');
export const recordDigest = (rows) => sha(recordsDigestInput(rows));
export const RECORD_COLUMNS = ['information_id', 'doc_id', 'entity', 'entity_key', 'information_type',
  'category', 'period', 'statement', 'forecast_measurement_json', 'sort_order', 'created_at'];
export const LEGACY_FEED_EXTRACTION_KEYS = ['records', 'categoryCandidates', 'taggingStatus', 'taggingInputFingerprint',
  'taggingContentSha256', 'tagContract', 'tagCategoryCatalogHash', 'tagPromptHash', 'tagCandidatePolicyHash',
  'taggedAt', 'lastTagAttemptAt', 'nextRetryAt', 'tagLeaseOwner', 'tagLeaseUntil', 'tagAttempts', 'lastTagError',
  'lastAttemptContract', 'lastAttemptCategoryCatalogHash', 'lastAttemptPromptHash', 'lastAttemptCandidatePolicyHash'];

export function openInformationDatabase(options = {}, readOnly = false) {
  const db = new DatabaseSync(resolveExistingLocalD1Database(options), { readOnly });
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${LOCAL_SQLITE_BUSY_TIMEOUT_MS};`);
  if (readOnly) db.exec('PRAGMA query_only=ON');
  return db;
}

export function inTransaction(db, operation, write = true) {
  db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = operation(db);
    if (result && typeof result.then === 'function') throw new Error('network/async work is forbidden inside an information transaction');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function withInformationDatabase(options, operation, write = true) {
  const db = openInformationDatabase(options, !write);
  try { return inTransaction(db, operation, write); } finally { db.close(); }
}

export function assertInformationSchema(db) {
  const columns = db.prepare('PRAGMA table_info(knowledge_information_records)').all().map((row) => row.name);
  if (!columns.includes('doc_id') || columns.includes('result_id')) throw new Error('information storage migration must be applied before using the new writer');
}

export function readDocument(db, docId) {
  const row = db.prepare(`SELECT d.*, c.content_key, c.content_url, c.content_type, c.content_encoding,
    c.content_bytes, c.content_sha256 FROM knowledge_docs d
    LEFT JOIN knowledge_doc_content_refs c ON c.doc_id=d.doc_id WHERE d.doc_id=?`).get(docId);
  if (!row) throw new Error(`information document not found: ${docId}`);
  return { ...row, meta: JSON.parse(row.metadata_json || '{}') };
}

export function readInformationRows(db, docId) {
  return db.prepare('SELECT * FROM knowledge_information_records WHERE doc_id=? ORDER BY sort_order').all(docId).map((row) => ({ ...row }));
}

export function readDocumentSnapshot(db, docId) {
  const row = readDocument(db, docId);
  return { ...row, records: readInformationRows(db, docId),
    tags: db.prepare('SELECT * FROM knowledge_doc_tags WHERE doc_id=? ORDER BY tag').all(docId).map((tag) => ({ ...tag })) };
}

export function feedInputFingerprint(row, body, contract) {
  // Keep compatibility with already validated feed-tag-v5 extractions.
  return sha(JSON.stringify([body, row.title, row.published_at, contract.categoryCatalogHash,
    contract.promptHash, contract.candidatePolicyHash, contract.contractVersion, contract.model]));
}

export function sourceExpectation(row, body) {
  return { contentSha256: sha(body), fullBodyHash: row.feed?.fullBodyHash ?? row.meta?.feed?.fullBodyHash ?? null,
    title: row.title, publishedAt: row.published_at, sourceType: row.source_type,
    contentType: row.feed?.contentType ?? row.meta?.feed?.contentType ?? '' };
}

function assertSource(row, expected) {
  if (row.content_sha256 !== expected.contentSha256 || row.meta.feed?.fullBodyHash !== expected.fullBodyHash
    || row.title !== expected.title || row.published_at !== expected.publishedAt
    || row.source_type !== expected.sourceType || (row.meta.feed?.contentType || '') !== expected.contentType) {
    throw new Error('extraction input changed; result not committed');
  }
}

export function shouldAttemptExtraction(state, fingerprint, contract, now = Date.now()) {
  if (!state) return true;
  const attempt = state.lastAttempt || {};
  if (state.status === 'processing' && Number(attempt.leaseUntil || 0) > now) return false;
  if (state.status === 'failed' && attempt.inputFingerprint === fingerprint && contractMatches(attempt, contract)
    && (Number(attempt.attempts || 0) >= 5 || Number(attempt.nextRetryAt || 0) > now)) return false;
  const current = state.current;
  return !(state.status === 'complete' && current?.storageVersion === INFORMATION_STORAGE_VERSION
    && current.provenanceStatus === 'verified' && current.inputFingerprint === fingerprint
    && !!current.contentSha256 && !!current.recordsDigest && contractMatches(current, contract));
}

export function claimExtraction(docId, { owner, fingerprint, source, contract, now = Date.now() }, options = {}) {
  return withInformationDatabase(options, (db) => {
    assertInformationSchema(db);
    const row = readDocument(db, docId);
    assertSource(row, source);
    if (Object.hasOwn(row.meta.feed || {}, 'records') || Object.hasOwn(row.meta.feed || {}, 'taggingStatus')) {
      throw new Error('legacy feed metadata needs backfill before extraction');
    }
    const state = row.meta.informationExtraction || { status: 'pending', current: null, categoryCandidates: null };
    if (!shouldAttemptExtraction(state, fingerprint, contract, now)) return false;
    const oldAttempt = state.lastAttempt || {};
    row.meta.informationExtraction = { ...state, storageVersion: INFORMATION_STORAGE_VERSION, status: 'processing',
      lastAttempt: { ...contract, inputFingerprint: fingerprint, leaseOwner: owner, leaseUntil: now + 15 * 60_000,
        attemptedAt: now, attempts: oldAttempt.inputFingerprint === fingerprint && contractMatches(oldAttempt, contract)
          ? Number(oldAttempt.attempts || 0) : 0 } };
    writeMetadata(db, row, now);
    return true;
  });
}

export function makeInformationRows(docId, fingerprint, records, candidates, createdAt) {
  const occurrences = new Map();
  return records.map((record, sortOrder) => {
    const identity = canonicalJson(record);
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    return {
      information_id: `i_${sha(canonicalJson([docId, fingerprint, record, occurrence]))}`,
      doc_id: docId, entity: record.entity, entity_key: entityKeyForRecord(record, candidates),
      information_type: record.informationType, category: record.category, period: record.period ?? null,
      statement: record.statement, forecast_measurement_json: canonicalJson(record.forecastMeasurement || {}),
      sort_order: sortOrder, created_at: createdAt,
    };
  });
}

export function makeSuccessfulState(row, records, categoryCandidates, { fingerprint, contract, now,
  provenanceStatus = 'verified', status = 'complete', lastAttempt = {} }) {
  return { storageVersion: INFORMATION_STORAGE_VERSION, status,
    current: { ...contract, storageVersion: INFORMATION_STORAGE_VERSION,
      outcome: extractionOutcome(records, categoryCandidates), inputFingerprint: fingerprint,
      contentSha256: row.content_sha256, title: row.title, publishedAt: row.published_at,
      completedAt: now, recordsDigest: recordDigest(records), recordCount: records.length,
      categoryCandidateCount: categoryCandidates === null ? null : categoryCandidates.length, provenanceStatus },
    categoryCandidates, lastAttempt };
}

export function replaceInformationRows(db, docId, rows) {
  if (rows.some((row) => row.doc_id !== docId)) throw new Error('cross-document information replacement refused');
  const previous = new Map(readInformationRows(db, docId).map((row) => [row.information_id, row]));
  db.prepare('DELETE FROM knowledge_information_records WHERE doc_id=?').run(docId);
  const insert = db.prepare(`INSERT INTO knowledge_information_records (${RECORD_COLUMNS.join(',')}) VALUES (${RECORD_COLUMNS.map(() => '?').join(',')})`);
  for (const row of rows) {
    const old = previous.get(row.information_id);
    if (old && canonicalJson(rowToInformation(old)) !== canonicalJson(rowToInformation(row))) {
      throw new Error('an existing information ID cannot be assigned different content');
    }
    if (old) row.created_at = old.created_at;
    insert.run(...RECORD_COLUMNS.map((key) => row[key]));
  }
}

export function replaceInformationTags(db, docId, rows, current) {
  db.prepare(`DELETE FROM knowledge_doc_tags WHERE doc_id=? AND
    (tag LIKE 'company:%' OR tag LIKE 'category:%' OR tag LIKE 'topic:%' OR tag LIKE 'theme:%' OR tag LIKE 'focus:%')`).run(docId);
  if (!current?.inputFingerprint || current.provenanceStatus !== 'verified') return;
  const insert = db.prepare(`INSERT INTO knowledge_doc_tags (doc_id,tag,weight,tagging_input_fingerprint,contract_version) VALUES (?,?,?,?,?)`);
  for (const tag of tagsForInformationRows(rows)) insert.run(docId, tag.tag, tag.weight, current.inputFingerprint, current.contractVersion);
}

export function clearLegacyFeedExtraction(meta) {
  if (meta.feed) for (const key of LEGACY_FEED_EXTRACTION_KEYS) delete meta.feed[key];
}

export function writeMetadata(db, row, now = Date.now()) {
  db.prepare('UPDATE knowledge_docs SET metadata_json=?,updated_at=? WHERE doc_id=?').run(JSON.stringify(row.meta), now, row.doc_id);
}

export function commitExtraction(docId, { owner, fingerprint, source, contract, body, records,
  categoryCandidates, companyCandidates, now = Date.now() }, options = {}) {
  // Revalidate the producer contract at the storage boundary, outside the lock.
  const parsed = parseFeedExtraction(JSON.stringify({ records, categoryCandidates }), body.slice(0, 12000));
  const informationRows = makeInformationRows(docId, fingerprint, parsed.records, companyCandidates, now);
  return withInformationDatabase(options, (db) => {
    assertInformationSchema(db);
    const row = readDocument(db, docId);
    assertSource(row, source);
    const attempt = row.meta.informationExtraction?.lastAttempt;
    if (row.meta.informationExtraction?.status !== 'processing' || attempt?.leaseOwner !== owner
      || Number(attempt.leaseUntil || 0) <= now || attempt.inputFingerprint !== fingerprint
      || !contractMatches(attempt, contract) || feedInputFingerprint(row, body, contract) !== fingerprint) {
      throw new Error('extraction lease or fingerprint changed; result not committed');
    }
    replaceInformationRows(db, docId, informationRows);
    row.meta.informationExtraction = makeSuccessfulState(row, informationRows, parsed.categoryCandidates,
      { fingerprint, contract, now, lastAttempt: { ...contract, inputFingerprint: fingerprint,
        attemptedAt: attempt.attemptedAt, attempts: 0, nextRetryAt: null, leaseOwner: null, leaseUntil: null } });
    replaceInformationTags(db, docId, informationRows, row.meta.informationExtraction.current);
    clearLegacyFeedExtraction(row.meta);
    writeMetadata(db, row, now);
    return { records: informationRows, state: row.meta.informationExtraction };
  });
}

export function failExtraction(docId, { owner, error, now = Date.now() }, options = {}) {
  return withInformationDatabase(options, (db) => {
    const row = readDocument(db, docId);
    const state = row.meta.informationExtraction;
    if (state?.status !== 'processing' || state.lastAttempt?.leaseOwner !== owner) return false;
    const attempts = Number(state.lastAttempt.attempts || 0) + 1;
    state.status = 'failed';
    state.lastAttempt = { ...state.lastAttempt, attempts, attemptedAt: now, leaseOwner: null, leaseUntil: null,
      nextRetryAt: now + Math.min(86400_000, 60_000 * 2 ** Math.min(attempts, 10)),
      error: String(error?.message || error).slice(0, 300) };
    writeMetadata(db, row, now);
    return true;
  });
}

export function mergeStorySourceReference(storyKey, reference, options = {}) {
  return withInformationDatabase(options, (db) => {
    const rows = db.prepare(`SELECT doc_id,metadata_json FROM knowledge_docs WHERE source_type='information_feed'
      AND json_extract(metadata_json,'$.feed.storyKey')=?`).all(storyKey);
    const updated = new Map();
    for (const row of rows) {
      row.meta = JSON.parse(row.metadata_json);
      const sources = row.meta.feed.sources || [];
      const index = sources.findIndex((item) => item.sourceKey === reference.sourceKey
        && item.sourceItemId === reference.sourceItemId && item.url === reference.url);
      if (index >= 0 && sources[index].contentHash === reference.contentHash) continue;
      row.meta.feed.sources = index >= 0 ? sources.map((item, i) => i === index ? reference : item) : [...sources, reference];
      writeMetadata(db, row);
      updated.set(row.doc_id, row.meta.feed.sources);
    }
    return updated;
  });
}
