import { canonicalJson, extractionIsCurrent, INFORMATION_STORAGE_VERSION, sqlText as q,
  tagsForInformationRows } from '../../src/modules/knowledge/domain/information-records.ts';
import { sha, recordDigest, RECORD_COLUMNS } from './information-records-store.mjs';
import policy from '../../config/knowledge/information-feed-policy.json' with { type: 'json' };
const relevanceConfig = policy.relevance;

export const DOCUMENT_COLUMNS = ['doc_id','source_type','report_type','source_name','title','url','published_at','fetched_at','event_time','access_method',
  'summary','content_preview','metadata_json','sort_time','source_name_normalized','updated_at'];
export const CONTENT_COLUMNS = ['doc_id','content_key','content_url','content_type','content_encoding','content_bytes','content_sha256','updated_at'];

export function publicationEligible(snapshot, contract, permissions, categories) {
  const feed = snapshot.meta.feed || {};
  const state = snapshot.meta.informationExtraction;
  if (snapshot.source_type !== 'information_feed' || snapshot.access_method !== 'markdown' || feed.version !== 'v1'
    || feed.originalFormat !== 'text' || permissions[feed.sourceKey]?.fullTextAllowed !== true || !snapshot.content_key
    || feed.investmentGate?.policyVersion !== relevanceConfig.version
    || feed.investmentGate?.effectiveDisposition !== 'pass'
    || feed.investmentGate?.title !== snapshot.title
    || feed.investmentGate?.bodySha256 !== snapshot.content_sha256
    || !extractionIsCurrent(state, snapshot, contract) || !Array.isArray(state.categoryCandidates) || state.categoryCandidates.length
    || !snapshot.records.length || state.current.recordCount !== snapshot.records.length
    || snapshot.records.some((record) => !categories.has(record.category))
    || recordDigest(snapshot.records) !== state.current.recordsDigest) return false;
  return canonicalJson(validSnapshotTags(snapshot)) === canonicalJson(tagsForInformationRows(snapshot.records).sort((a,b) => a.tag.localeCompare(b.tag)));
}

export function validSnapshotTags(snapshot) {
  const current = snapshot.meta.informationExtraction?.current;
  return snapshot.tags.filter((tag) => (tag.tag.startsWith('category:') || tag.tag.startsWith('company:'))
    && tag.tagging_input_fingerprint === current?.inputFingerprint && tag.contract_version === current?.contractVersion)
    .map(({ tag, weight }) => ({ tag, weight })).sort((a,b) => a.tag.localeCompare(b.tag));
}

export function publicationFingerprint(snapshot) {
  return sha(canonicalJson({ storageVersion: INFORMATION_STORAGE_VERSION,
    document: Object.fromEntries(DOCUMENT_COLUMNS.filter((column) => !['metadata_json','updated_at'].includes(column)).map((column) => [column,snapshot[column]])),
    content: { key:snapshot.content_key, sha256:snapshot.content_sha256 },
    feed: snapshot.meta.feed ? { storyKey:snapshot.meta.feed.storyKey, kind:snapshot.meta.feed.kind,
      previousItemId:snapshot.meta.feed.previousItemId, sources:snapshot.meta.feed.sources,
      originalFormat:snapshot.meta.feed.originalFormat, sourceKey:snapshot.meta.feed.sourceKey,
      investmentGate:snapshot.meta.feed.investmentGate } : null,
    current:snapshot.meta.informationExtraction?.current, tags:validSnapshotTags(snapshot) }));
}

export function remotePublicationMetadata(snapshot, token, fingerprint) {
  const feed = {};
  for (const key of ['version','dedupeVersion','kind','storyKey','previousItemId','fullBodyHash','sketch','entityCodes',
    'originalFormat','contentType','sourceKey','sourceItemId','sources','investmentGate']) {
    if (snapshot.meta.feed?.[key] !== undefined) feed[key] = snapshot.meta.feed[key];
  }
  // Only whitelisted successful provenance reaches production. No candidate
  // statements, errors, leases, archives, or local migration diagnostics.
  return { feed: { ...feed, publishAllowed:false, publicationToken:token, publishedFingerprint:fingerprint },
    informationExtraction: { storageVersion: INFORMATION_STORAGE_VERSION, status:'complete',
      current: structuredClone(snapshot.meta.informationExtraction.current) } };
}

export function stagePublicationStatements(snapshot, token, fingerprint) {
  const staged = { ...snapshot, metadata_json: JSON.stringify(remotePublicationMetadata(snapshot, token, fingerprint)) };
  const owns = `EXISTS (SELECT 1 FROM knowledge_docs pd WHERE pd.doc_id=${q(snapshot.doc_id)} AND json_extract(pd.metadata_json,'$.feed.publicationToken')=${q(token)})`;
  return [
    // First statement closes visibility. Every following statement is owner-
    // fenced; a superseded publisher cannot replace a newer publisher's rows.
    `INSERT INTO knowledge_docs (${DOCUMENT_COLUMNS.join(',')}) VALUES (${DOCUMENT_COLUMNS.map((column) => q(staged[column])).join(',')})
      ON CONFLICT(doc_id) DO UPDATE SET ${DOCUMENT_COLUMNS.filter((column) => column !== 'doc_id').map((column) => `${column}=excluded.${column}`).join(',')};`,
    `INSERT INTO knowledge_doc_content_refs (${CONTENT_COLUMNS.join(',')}) SELECT ${CONTENT_COLUMNS.map((column) => q(staged[column])).join(',')} WHERE ${owns}
      ON CONFLICT(doc_id) DO UPDATE SET ${CONTENT_COLUMNS.filter((column) => column !== 'doc_id').map((column) => `${column}=excluded.${column}`).join(',')};`,
    `DELETE FROM knowledge_information_records WHERE doc_id=${q(snapshot.doc_id)} AND ${owns};`,
    ...snapshot.records.map((record) => `INSERT INTO knowledge_information_records (${RECORD_COLUMNS.join(',')}) SELECT ${RECORD_COLUMNS.map((column) => q(record[column])).join(',')} WHERE ${owns};`),
    `DELETE FROM knowledge_doc_tags WHERE doc_id=${q(snapshot.doc_id)} AND ${owns} AND
      (tag LIKE 'category:%' OR tag LIKE 'company:%' OR tag LIKE 'topic:%' OR tag LIKE 'focus:%' OR tag LIKE 'theme:%');`,
    ...validSnapshotTags(snapshot).map((tag) => `INSERT INTO knowledge_doc_tags (doc_id,tag,weight,tagging_input_fingerprint,contract_version)
      SELECT ${q(snapshot.doc_id)},${q(tag.tag)},${q(tag.weight)},${q(snapshot.meta.informationExtraction.current.inputFingerprint)},${q(snapshot.meta.informationExtraction.current.contractVersion)} WHERE ${owns};`),
  ];
}

export function verifyStagedPublication(expected, actual, token, fingerprint) {
  if (!actual || canonicalJson(actual.meta) !== canonicalJson(remotePublicationMetadata(expected, token, fingerprint))) {
    throw new Error('remote publication metadata or owner mismatch');
  }
  for (const column of [...DOCUMENT_COLUMNS, ...CONTENT_COLUMNS]) {
    if (column === 'metadata_json') continue;
    if ((actual[column] ?? null) !== (expected[column] ?? null)) throw new Error(`remote publication column mismatch: ${column}`);
  }
  if (canonicalJson(actual.records) !== canonicalJson(expected.records)
    || recordDigest(actual.records) !== expected.meta.informationExtraction.current.recordsDigest
    || canonicalJson(validSnapshotTags(actual)) !== canonicalJson(validSnapshotTags(expected))) {
    throw new Error('remote information records/tags failed content verification');
  }
}

export function exposePublicationSql(snapshot, token, fingerprint) {
  return `UPDATE knowledge_docs SET metadata_json=json_set(metadata_json,'$.feed.publishAllowed',json('true'))
    WHERE doc_id=${q(snapshot.doc_id)} AND json_extract(metadata_json,'$.feed.publicationToken')=${q(token)}
    AND json_extract(metadata_json,'$.feed.publishedFingerprint')=${q(fingerprint)}
    AND json_extract(metadata_json,'$.informationExtraction.current.recordsDigest')=${q(snapshot.meta.informationExtraction.current.recordsDigest)}
    AND (SELECT count(*) FROM knowledge_information_records r WHERE r.doc_id=knowledge_docs.doc_id)=${snapshot.records.length};`;
}

export function hidePublicationSql(docId, token) {
  return `UPDATE knowledge_docs SET metadata_json=json_set(metadata_json,'$.feed.publishAllowed',json('false')) WHERE doc_id=${q(docId)}
    ${token ? `AND json_extract(metadata_json,'$.feed.publicationToken')=${q(token)}` : ''};`;
}
