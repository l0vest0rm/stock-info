import { readFileSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { parseFeedExtraction } from './information-feed-extraction.mjs';
import { feedCompanyCandidates } from './information-feed-company-candidates.mjs';
import { INFORMATION_STORAGE_VERSION, canonicalJson, contractMatches, rowToInformation } from '../../src/modules/knowledge/domain/information-records.ts';
import { LEGACY_FEED_EXTRACTION_KEYS, sha, recordDigest, feedInputFingerprint, makeInformationRows,
  makeSuccessfulState, clearLegacyFeedExtraction, replaceInformationRows, replaceInformationTags,
  writeMetadata, readDocumentSnapshot } from './information-records-store.mjs';

export function readInformationBody(key, root = process.env.KNOWLEDGE_CONTENT_LOCAL_DIR || '/Users/terry/git/data/stock-info/knowledge/content-cache') {
  if (!key?.startsWith('knowledge-content/')) return null;
  const directory = resolve(root);
  const path = resolve(directory, key.slice('knowledge-content/'.length));
  if (!path.startsWith(directory + sep) || !existsSync(path)) return null;
  const bytes = readFileSync(path);
  return (key.endsWith('.br') ? brotliDecompressSync(bytes) : bytes).toString('utf8');
}

export function snapshotIdentity(snapshot) {
  return sha(canonicalJson({ doc_id: snapshot.doc_id, title: snapshot.title, published_at: snapshot.published_at,
    source_type: snapshot.source_type, content_key: snapshot.content_key, content_sha256: snapshot.content_sha256,
    metadata_json: snapshot.metadata_json, records: snapshot.records, tags: snapshot.tags }));
}

function legacyAttempt(feed) {
  return { contractVersion: feed.lastAttemptContract ?? null, promptHash: feed.lastAttemptPromptHash ?? null,
    categoryCatalogHash: feed.lastAttemptCategoryCatalogHash ?? null,
    candidatePolicyHash: feed.lastAttemptCandidatePolicyHash ?? null, model: null,
    inputFingerprint: null, attempts: Number(feed.tagAttempts || 0), attemptedAt: feed.lastTagAttemptAt ?? null,
    nextRetryAt: feed.nextRetryAt ?? null, error: feed.lastTagError ?? null, leaseOwner: null, leaseUntil: null };
}

function legacyRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['entity','informationType','category','period','statement','forecastMeasurement'].includes(key))
    || !['fact','guidance','forecast','opinion','event','relationship'].includes(value.informationType)
    || ['entity','category','statement'].some((key) => typeof value[key] !== 'string' || !value[key].trim())
    || (value.period != null && typeof value.period !== 'string')
    || (value.forecastMeasurement != null && (typeof value.forecastMeasurement !== 'object' || Array.isArray(value.forecastMeasurement)))) {
    throw new Error('legacy record cannot be represented without data loss');
  }
  return { entity: value.entity, informationType: value.informationType, category: value.category,
    period: value.period || null, statement: value.statement, forecastMeasurement: value.forecastMeasurement || null };
}

function preserveLegacyIds(existing, next) {
  const groups = new Map();
  for (const row of existing) {
    const key = canonicalJson(rowToInformation(row));
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  if (existing.length !== next.length) throw new Error('conflicting relational and JSON record counts');
  return next.map((row) => {
    const old = groups.get(canonicalJson(rowToInformation(row)))?.shift();
    if (!old) throw new Error('conflicting relational and JSON record content');
    return { ...row, information_id: old.information_id, created_at: old.created_at };
  });
}

export function planInformationBackfill(snapshot, { body, aliases = [], contract, companyPolicy = {}, now = Date.now() }) {
  const meta = structuredClone(snapshot.meta);
  const feed = meta.feed || {};
  const previous = meta.informationExtraction;
  const hasLegacy = LEGACY_FEED_EXTRACTION_KEYS.some((key) => Object.hasOwn(feed, key));
  if (!hasLegacy) {
    if (previous?.current && !previous.current.recordsDigest) {
      previous.current.recordsDigest = recordDigest(snapshot.records);
      previous.current.recordCount = snapshot.records.length;
      return { kind: 'legacy_relational', meta, records: snapshot.records, issues: ['historical extraction provenance is unknown'] };
    }
    return { kind: 'unchanged' };
  }
  if (feed.taggingStatus === 'processing' && Number(feed.tagLeaseUntil || 0) > now) {
    throw new Error('active legacy extraction lease; stop the writer before backfill');
  }
  const issues = [];
  let records = snapshot.records;
  let candidates = Array.isArray(feed.categoryCandidates) ? feed.categoryCandidates : null;
  let status = ['pending','processing','complete','failed'].includes(feed.taggingStatus) ? feed.taggingStatus : 'pending';
  if (status === 'processing') status = 'pending';
  const attempt = legacyAttempt(feed);
  const hasJsonRecords = Object.hasOwn(feed, 'records');
  if (hasJsonRecords) {
    if (!Array.isArray(feed.records)) throw new Error('legacy records is not an array; quarantine requires an explicit archive');
    const formal = feed.records.map(legacyRecord);
    const oldContract = { contractVersion: feed.tagContract ?? null, promptHash: feed.tagPromptHash ?? null,
      categoryCatalogHash: feed.tagCategoryCatalogHash ?? null, candidatePolicyHash: feed.tagCandidatePolicyHash ?? null,
      model: contract.model };
    let parserValid = false;
    try {
      const parsed = parseFeedExtraction(JSON.stringify({ records: formal, categoryCandidates: candidates || [] }), (body || '').slice(0, 12000));
      // A measurement silently reduced to null by the parser is NOT a safe backfill.
      if (canonicalJson(parsed.records) !== canonicalJson(formal)) throw new Error('parser would alter legacy record content');
      parserValid = true;
    } catch (error) { issues.push(String(error.message || error)); }
    if (candidates === null) issues.push('category candidate assessment is unknown');
    if (body === null || !feed.taggingContentSha256 || sha(body) !== feed.taggingContentSha256
      || feed.taggingContentSha256 !== snapshot.content_sha256) issues.push('legacy content binding cannot be verified');
    if (!contractMatches(oldContract, contract)) issues.push('legacy extraction contract is stale or unknown');
    if (body === null || !feed.taggingInputFingerprint || feedInputFingerprint(snapshot, body, contract) !== feed.taggingInputFingerprint) {
      issues.push('legacy input fingerprint cannot be verified');
    }
    if (!Number.isSafeInteger(feed.taggedAt) || feed.taggedAt <= 0) {
      if (formal.length) throw new Error('legacy records have no reliable extraction time');
      issues.push('legacy extraction completion time is unknown');
    }
    const bindingVerified = parserValid && !issues.some((issue) => issue !== 'category candidate assessment is unknown');
    const companyCandidates = body === null ? [] : feedCompanyCandidates(aliases, snapshot.title, body, companyPolicy);
    records = makeInformationRows(snapshot.doc_id, feed.taggingInputFingerprint || `legacy:${sha(canonicalJson(formal))}`,
      formal, companyCandidates, feed.taggedAt ?? 0);
    if (previous?.current || snapshot.records.length) records = preserveLegacyIds(snapshot.records, records);
    meta.informationExtraction = makeSuccessfulState(snapshot, records, candidates,
      { fingerprint: feed.taggingInputFingerprint ?? null, contract: oldContract, now: feed.taggedAt ?? null,
        status, lastAttempt: attempt, provenanceStatus: bindingVerified ? 'verified' : 'legacy_unverified' });
    const current = meta.informationExtraction.current;
    current.contentSha256 = feed.taggingContentSha256 ?? null;
    if (!bindingVerified) { current.model = null; current.title = null; current.publishedAt = null; }
    if (issues.length) meta.informationExtraction.migrationIssues = issues;
  } else if (previous?.current) {
    previous.current.recordsDigest = recordDigest(records);
    previous.current.recordCount = records.length;
    meta.informationExtraction = previous;
    issues.push('retained legacy relational outcome without inventing provenance');
  } else {
    if (status === 'complete') { status = 'pending'; issues.push('legacy completion has no records array; outcome is unknown'); }
    meta.informationExtraction = { storageVersion: INFORMATION_STORAGE_VERSION, status, current: null,
      categoryCandidates: candidates, lastAttempt: attempt, ...(issues.length ? { migrationIssues: issues } : {}) };
  }
  clearLegacyFeedExtraction(meta);
  return { kind: hasJsonRecords ? 'records' : 'state', meta, records, issues };
}

export function applyInformationBackfill(db, snapshot, plan) {
  if (plan.kind === 'unchanged') return;
  const latest = readDocumentSnapshot(db, snapshot.doc_id);
  if (snapshotIdentity(latest) !== snapshotIdentity(snapshot)) throw new Error('document changed after backfill planning');
  replaceInformationRows(db, snapshot.doc_id, plan.records);
  latest.meta = plan.meta;
  if (latest.meta.informationExtraction?.current) {
    latest.meta.informationExtraction.current.recordsDigest = recordDigest(plan.records);
    latest.meta.informationExtraction.current.recordCount = plan.records.length;
  }
  replaceInformationTags(db, snapshot.doc_id, plan.records, latest.meta.informationExtraction?.current);
  writeMetadata(db, latest);
  const saved = readDocumentSnapshot(db, snapshot.doc_id);
  if (canonicalJson(saved.records) !== canonicalJson(plan.records)
    || Object.hasOwn(saved.meta.feed || {}, 'records')) throw new Error('backfill read-back mismatch');
}
