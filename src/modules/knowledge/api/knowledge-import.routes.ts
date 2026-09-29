import { Hono } from 'hono';
import type { AppEnv } from '../../../types';
import { fail, ok } from '../../../shared/http';
import { reportSyncTokenMatches } from '../../../shared/remote-report-sync';

export const knowledgeImportRoutes = new Hono<AppEnv>();

const INLINE_LIMIT_BYTES = 4096;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = MAX_CONTENT_BYTES + 8192;
type ImportBody = {
  sourceKey: string;
  sourceItemId: string;
  sourceType?: 'information_feed' | 'external_document';
  sourceName?: string;
  title: string;
  url: string;
  publishedAt: string;
  body: string;
};

function nonempty(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  }
  catch { return false; }
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function readJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('empty request');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) throw new Error('request too large');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
}

function validate(value: unknown): ImportBody | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!nonempty(body.sourceKey, 64) || !/^[a-z0-9][a-z0-9_-]*$/.test(body.sourceKey)
    || !nonempty(body.sourceItemId, 200) || !nonempty(body.title, 200)
    || !nonempty(body.url, 2048) || !validUrl(body.url)
    || !nonempty(body.publishedAt, 40)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(body.publishedAt)
    || Number.isNaN(Date.parse(body.publishedAt))
    || !nonempty(body.body, MAX_CONTENT_BYTES)
    || (body.sourceType !== undefined && body.sourceType !== 'information_feed' && body.sourceType !== 'external_document')
    || (body.sourceName !== undefined && !nonempty(body.sourceName, 100))) return null;
  return body as ImportBody;
}

// The bearer token authorizes publication. Collectors may retry the same source version safely.
knowledgeImportRoutes.post('/internal/knowledge/import', async c => {
  const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!reportSyncTokenMatches(c.env.KNOWLEDGE_IMPORT_TOKEN, bearer)) return fail(c, 401, 'unauthorized');
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type') || '')) return fail(c, 415, 'expected application/json');
  let payload: ImportBody | null;
  try { payload = validate(await readJson(c.req.raw)); }
  catch { return fail(c, 400, 'invalid or oversized JSON'); }
  if (!payload) return fail(c, 400, 'invalid knowledge import');

  const normalizedBody = payload.body.replace(/\r\n?/g, '\n').trim();
  const content = new TextEncoder().encode(normalizedBody);
  if (!content.length || content.length > MAX_CONTENT_BYTES || normalizedBody.includes('\0')) return fail(c, 400, 'invalid content');
  const sourceType = payload.sourceType || 'information_feed';
  const publishedAt = new Date(payload.publishedAt).toISOString();
  const now = new Date();
  const contentHash = await sha256(content);
  const sourceItemId = payload.sourceItemId.trim();
  const identityHash = await sha256(`${payload.sourceKey}\0${sourceItemId}`);
  const versionHash = await sha256(`${identityHash}\0${contentHash}`);
  const docId = `${sourceType === 'information_feed' ? 'f' : 'x'}_${versionHash.slice(0, 24)}`;
  const storyKey = `f_${identityHash.slice(0, 24)}`;
  const isInline = content.length <= INLINE_LIMIT_BYTES;
  const contentKey = isInline ? null : `knowledge-content/external/${contentHash}.txt`;
  if (contentKey) {
    const bucket = c.env.KNOWLEDGE_CONTENT_BUCKET;
    if (!bucket) return fail(c, 503, 'knowledge content bucket unavailable');
    const stored = await bucket.put(contentKey, content, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
    if (!stored || stored.size !== content.length) return fail(c, 503, 'knowledge content upload failed');
  }

  const metadata = sourceType === 'information_feed'
    ? { feed: { version: 'v2', importVersion: 'api-v1', originalFormat: 'text', contentType: 'news',
      sourceKey: payload.sourceKey, sourceItemId, storyKey, kind: 'new',
      fullBodyHash: contentHash, publishAllowed: true, sources: [{ sourceKey: payload.sourceKey }] } }
    : { externalImport: { version: 'api-v1', sourceKey: payload.sourceKey, sourceItemId, contentSha256: contentHash } };
  const db = c.env.DB;
  const statements = [db.prepare(`insert into knowledge_docs
    (doc_id,source_type,report_type,source_name,title,url,published_at,fetched_at,discovery_method,access_method,
     summary,content_preview,inline_content,inline_content_sha256,metadata_json,sort_time,source_name_normalized,updated_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(doc_id) do nothing`).bind(
    docId, sourceType, sourceType === 'information_feed' ? 'news' : 'external_document',
    payload.sourceName?.trim() || payload.sourceKey, payload.title.trim(), payload.url.trim(), publishedAt, now.toISOString(),
    'external_import', 'markdown', normalizedBody.slice(0, 600), normalizedBody.slice(0, 280),
    isInline ? normalizedBody : null, isInline ? contentHash : null, JSON.stringify(metadata),
    publishedAt, (payload.sourceName?.trim() || payload.sourceKey).toLowerCase(), now.getTime(),
  )];
  if (contentKey) statements.push(db.prepare(`insert into knowledge_doc_content_refs
    (doc_id,content_key,content_url,content_type,content_encoding,content_bytes,content_sha256,updated_at)
    values (?,?,?,?,?,?,?,?) on conflict(doc_id) do nothing`).bind(
    docId, contentKey, '', 'text/plain; charset=utf-8', 'identity', content.length, contentHash, now.getTime(),
  ));
  await db.batch(statements);
  return ok(c, { docId, storyKey: sourceType === 'information_feed' ? storyKey : null,
    storage: isInline ? 'd1' : 'r2', contentSha256: contentHash });
});
