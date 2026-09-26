// Shared by the Node extractor and the Worker read model. No Node dependencies.
export const INFORMATION_STORAGE_VERSION = 'information-records-v1';

export type InformationRecord = {
  entity: string;
  informationType: string;
  category: string;
  period: string | null;
  statement: string;
  forecastMeasurement: Record<string, unknown> | null;
};
export type InformationRow = {
  information_id: string; doc_id: string; entity: string; entity_key: string | null;
  information_type: string; category: string; period: string | null; statement: string;
  forecast_measurement_json: string; sort_order: number; created_at: number;
};
export type ExtractionContract = {
  contractVersion: string; promptHash: string; categoryCatalogHash: string;
  candidatePolicyHash: string; model: string;
};
export type ExtractionCurrent = ExtractionContract & {
  storageVersion: string; outcome: 'extracted' | 'no_information' | 'needs_review';
  inputFingerprint: string; contentSha256: string; completedAt: number;
  recordsDigest: string; recordCount: number; categoryCandidateCount: number | null;
  provenanceStatus: 'verified' | 'legacy_unverified';
  title: string; publishedAt: string | null;
};
export type ExtractionState = {
  storageVersion?: string;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  current: ExtractionCurrent | null;
  categoryCandidates?: unknown[] | null;
  lastAttempt?: Record<string, unknown>;
};

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

export function rowToInformation(row: InformationRow): InformationRecord {
  const measurement = JSON.parse(row.forecast_measurement_json);
  if (!measurement || typeof measurement !== 'object' || Array.isArray(measurement)) {
    throw new Error('invalid stored forecast measurement');
  }
  return { entity: row.entity, informationType: row.information_type, category: row.category,
    period: row.period, statement: row.statement,
    forecastMeasurement: Object.keys(measurement).length ? measurement : null };
}

export function recordsDigestInput(rows: InformationRow[]): string {
  return canonicalJson([...rows].sort((a, b) => a.sort_order - b.sort_order).map((row) => ({
    information_id: row.information_id, doc_id: row.doc_id, entity_key: row.entity_key,
    sort_order: row.sort_order, ...rowToInformation(row),
  })));
}

export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function contractMatches(current: Partial<ExtractionContract> | null | undefined, contract: ExtractionContract): boolean {
  return !!current && (Object.keys(contract) as Array<keyof ExtractionContract>).every((key) => current[key] === contract[key]);
}

export function extractionIsCurrent(state: ExtractionState | null | undefined, row: {
  title: string; published_at: string | null; content_sha256: string | null;
}, contract: ExtractionContract, allowReview = false): boolean {
  const current = state?.current;
  return !!current && state?.status === 'complete'
    && current.storageVersion === INFORMATION_STORAGE_VERSION && current.provenanceStatus === 'verified'
    && contractMatches(current, contract) && !!current.inputFingerprint && !!current.recordsDigest
    && !!row.content_sha256 && current.contentSha256 === row.content_sha256
    && current.title === row.title && current.publishedAt === row.published_at
    && (allowReview || (current.outcome === 'extracted' && current.categoryCandidateCount === 0));
}

export function extractionOutcome(records: unknown[], candidates: unknown[] | null): ExtractionCurrent['outcome'] {
  return candidates === null || candidates.length > 0 ? 'needs_review' : records.length ? 'extracted' : 'no_information';
}

export function sqlText(value: unknown): string {
  return value === null || value === undefined ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
}

function safeAlias(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error('invalid SQL alias');
  return alias;
}

// Keep all API filters on the same success/content/contract gate. The complete
// row set is also verified against recordsDigest when reading/publishing it.
export function currentExtractionSql(alias: string, contract: ExtractionContract, allowReview = false): string {
  const d = safeAlias(alias);
  const field = (key: string) => `json_extract(${d}.metadata_json,'$.informationExtraction.current.${key}')`;
  return `coalesce((json_extract(${d}.metadata_json,'$.informationExtraction.status')='complete'
    AND ${field('storageVersion')}=${sqlText(INFORMATION_STORAGE_VERSION)}
    AND ${field('provenanceStatus')}='verified'
    AND ${Object.entries(contract).map(([key, value]) => `${field(key)}=${sqlText(value)}`).join(' AND ')}
    AND length(${field('inputFingerprint')})>0 AND length(${field('recordsDigest')})>0
    AND ${field('title')}=${d}.title AND ${field('publishedAt')} IS ${d}.published_at
    AND EXISTS (SELECT 1 FROM knowledge_doc_content_refs ic WHERE ic.doc_id=${d}.doc_id
      AND ic.content_sha256=${field('contentSha256')} AND ic.content_key IS NOT NULL)
    AND ${field('recordCount')}=(SELECT count(*) FROM knowledge_information_records irc WHERE irc.doc_id=${d}.doc_id)
    ${allowReview ? '' : `AND ${field('outcome')}='extracted' AND ${field('categoryCandidateCount')}=0`}),0)`;
}

// One SQL statement, one SQLite snapshot, no application-level N+1 requests and
// no pagination over an expanded one-to-many join. Uses UNIQUE(doc_id,sort_order).
export function informationRowsJsonSql(alias: string): string {
  const d = safeAlias(alias);
  return `(SELECT coalesce(json_group_array(json_object(
    'information_id', r.information_id, 'doc_id', r.doc_id, 'entity', r.entity, 'entity_key', r.entity_key,
    'information_type', r.information_type, 'category', r.category, 'period', r.period,
    'statement', r.statement, 'forecast_measurement_json', r.forecast_measurement_json,
    'sort_order', r.sort_order, 'created_at', r.created_at)), '[]')
    FROM (SELECT * FROM knowledge_information_records WHERE doc_id=${d}.doc_id ORDER BY sort_order) r)`;
}

export function tagsForInformationRows(rows: InformationRow[]): Array<{ tag: string; weight: number }> {
  const categories = [...new Set(rows.map((row) => row.category))];
  const companies = [...new Set(rows.map((row) => row.entity_key).filter((key): key is string => !!key?.startsWith('company:')))];
  return [...categories.map((category, index) => ({ tag: `category:${category}`, weight: Math.max(1, 100 - index * 10) })),
    ...companies.map((tag) => ({ tag, weight: 100 }))];
}
