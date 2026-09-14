import { currentUser } from "../../auth/auth";
import { isLocalDevelopmentRuntime } from "../../../shared/request";
import { Hono } from 'hono';
import type { AppEnv } from '../../../types';
import { ok, fail } from '../../../shared/http';
import { reportSyncTokenMatches } from '../../../shared/remote-report-sync';
import { MAX_CONTENT_BYTES, validateContent } from '../domain/content';

export const featuredReportRoutes = new Hono<AppEnv>();
type Row = { code: string; report_id: string; title: string; institution: string; report_date: string; pdf_key: string; content_key: string; content_hash: string; status: string };
featuredReportRoutes.get('/featured-reports/:code', async c => {
  c.header('Cache-Control', 'no-store');
  if (!isLocalDevelopmentRuntime(c.env) && !await currentUser(c.req.raw, c.env)) return fail(c, 401, '请先登录后查看研报');
  const code = c.req.param('code');
  if (!/^[1-9]\d{5}$/.test(code)) return fail(c, 400, '请输入 6 位研报码');
  const row = await c.env.DB.prepare('SELECT * FROM featured_reports WHERE code = ? AND status = ?').bind(code, 'published').first<Row>();
  if (!row) return fail(c, 404, '研报码不存在或报告已下架');
  const base = (c.env.KNOWLEDGE_CONTENT_PUBLIC_BASE_URL || 'https://content.tinfo.cc').replace(/\/$/, '');
  return ok(c, { code, title: row.title, institution: row.institution, reportDate: row.report_date,
    pdfUrl: `${base}/${row.pdf_key}`, contentUrl: `${base}/${row.content_key}`, contentHash: row.content_hash });
});

// This endpoint accepts only already-uploaded, locally reviewed artifacts.
featuredReportRoutes.post('/internal/featured-reports', async c => {
  const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!reportSyncTokenMatches(c.env.REPORT_SYNC_TOKEN, bearer)) return fail(c, 401, 'unauthorized');
  const body = await c.req.json<{ reportId: string; contentHash: string; expectedHash: string | null }>().catch(() => null);
  if (!body || !/^[a-f0-9]{64}$/.test(body.reportId) || !/^[a-f0-9]{64}$/.test(body.contentHash)
    || !(body.expectedHash === null || /^[a-f0-9]{64}$/.test(body.expectedHash))) return fail(c, 400, 'invalid publication');
  const bucket = c.env.KNOWLEDGE_CONTENT_BUCKET;
  if (!bucket) return fail(c, 503, 'content bucket unavailable');
  const pdfKey = `featured-reports/${body.reportId}/original.pdf`;
  const contentKey = `featured-reports/${body.reportId}/${body.contentHash}/content.json`;
  const [pdf, object] = await Promise.all([bucket.get(pdfKey), bucket.get(contentKey)]);
  if (!pdf || !object || object.size > MAX_CONTENT_BYTES) return fail(c, 400, 'publication objects missing or oversized');
  await pdf.body.cancel();
  const bytes = await object.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
  if (hash !== body.contentHash) return fail(c, 400, 'content checksum mismatch');
  let content;
  try { content = validateContent(JSON.parse(new TextDecoder().decode(bytes))); }
  catch (e) { return fail(c, 400, String(e)); }
  if (content.reportId !== body.reportId) return fail(c, 400, 'report identity mismatch');
  // UNIQUE(code) arbitrates collisions; UNIQUE(report_id) makes retries idempotent.
  for (let attempt = 0; attempt < 32; attempt++) {
    const existing = await c.env.DB.prepare('SELECT * FROM featured_reports WHERE report_id = ?').bind(body.reportId).first<Row>();
    if (existing) {
      if (existing.content_hash === hash) return ok(c, { code: existing.code, contentHash: hash });
      if (existing.content_hash !== body.expectedHash) return fail(c, 409, '报告已有其他发布版本；请重新核对后发布');
      const result = await c.env.DB.prepare(`UPDATE featured_reports SET title=?, institution=?, report_date=?, content_key=?, content_hash=?, updated_at=?
        WHERE report_id=? AND content_hash=?`).bind(content.title, content.institution, content.reportDate, contentKey, hash, Date.now(), body.reportId, body.expectedHash).run();
      if (!result.meta.changes) return fail(c, 409, 'concurrent publication');
      return ok(c, { code: existing.code, contentHash: hash });
    }
    const values = new Uint32Array(1);
    // Rejection sampling avoids modulo bias.
    do { crypto.getRandomValues(values); } while (values[0] >= Math.floor(2 ** 32 / 900000) * 900000);
    const code = String(100000 + values[0] % 900000);
    const result = await c.env.DB.prepare(`INSERT INTO featured_reports
      (code, report_id, title, institution, report_date, pdf_key, content_key, content_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .bind(code, body.reportId, content.title, content.institution, content.reportDate, pdfKey, contentKey, hash, Date.now(), Date.now()).run();
    if (result.meta.changes) return ok(c, { code, contentHash: hash });
  }
  return fail(c, 503, 'code allocation exhausted; retry publication');
});
