import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { featuredReportRoutes } from './featured-reports.routes.ts';
import { validateContent } from '../domain/content.ts';

const digest = x => createHash('sha256').update(x).digest('hex');
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../../../migrations/0140_featured_reports.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../../../../migrations/0139_auth_accounts.sql', import.meta.url), 'utf8'));
  const session = 'a'.repeat(43);
  const now = Date.now();
  db.prepare('INSERT INTO users (id, email, password_hash, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)')
    .run('reader', 'reader@example.com', 'unused', now, now);
  db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?)')
    .run(digest(session), 'reader', now + 60_000, now);
  const objects = new Map();
  const env = { APP_RUNTIME: 'cloudflare', LLM_RUNTIME: 'production', REPORT_SYNC_TOKEN: 'test-secret',
    KNOWLEDGE_CONTENT_PUBLIC_BASE_URL: 'https://content.test',
    DB: { prepare(sql) { let values = []; return { bind(...args) { values = args; return this; },
      async first() { return db.prepare(sql).get(...values) || null; },
      async run() { const r = db.prepare(sql).run(...values); return { meta: { changes: Number(r.changes) } }; } }; } },
    KNOWLEDGE_CONTENT_BUCKET: { async get(key) {
      if (!objects.has(key)) return null;
      const value = objects.get(key);
      return { size: value.length, body: new Response(value).body, arrayBuffer: async () => new TextEncoder().encode(value).buffer };
    } },
  };
  function stage(name = 'one', summary = '报告总结') {
    const reportId = digest(name);
    const content = { schemaVersion: 1, reportId, title: name, institution: 'Test', reportDate: '2026-09-14', pageCount: 2,
      summary, sections: [{ id: 's1', title: '需求', blocks: [{ id: 'p1-b1', translation: '需求增长', sourceLocations: [{ page: 1, bbox: [.1, .2, .8, .3] }] }] }] };
    const text = JSON.stringify(content), contentHash = digest(text);
    objects.set(`featured-reports/${reportId}/original.pdf`, '%PDF-test');
    objects.set(`featured-reports/${reportId}/${contentHash}/content.json`, text);
    return { reportId, contentHash, expectedHash: null };
  }
  async function publish(body, auth = 'Bearer test-secret') {
    return featuredReportRoutes.request('http://test/internal/featured-reports', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);
  }
  async function lookup(code, token = session) {
    return featuredReportRoutes.request(`http://test/featured-reports/${code}`, {
      headers: token ? { cookie: `tinfo_session=${token}` } : {},
    }, env);
  }
  return { db, env, objects, stage, publish, lookup };
}

test('publication is authenticated, complete, readable by members, idempotent and versioned', async () => {
  const f = fixture();
  try {
    const body = f.stage();
    assert.equal((await f.publish(body, '')).status, 401);
    const first = await (await f.publish(body)).json();
    assert.match(first.data.code, /^[1-9]\d{5}$/);
    assert.equal((await (await f.publish(body)).json()).data.code, first.data.code);
    const lookup = await f.lookup(first.data.code);
    assert.equal(lookup.headers.get('cache-control'), 'no-store');
    assert.equal(lookup.status, 200);
    const data = (await lookup.json()).data;
    assert.equal(data.pdfUrl, `https://content.test/featured-reports/${body.reportId}/original.pdf`);
    const revised = f.stage('one', '修订总结');
    assert.equal((await f.publish(revised)).status, 409);
    revised.expectedHash = body.contentHash;
    assert.equal((await (await f.publish(revised)).json()).data.code, first.data.code);
    assert.equal(f.db.prepare('select count(*) as n from featured_reports').get().n, 1);
    assert.equal((await f.publish(body)).status, 409);
    f.db.prepare("update featured_reports set status='withdrawn'").run();
    assert.equal((await f.lookup(first.data.code)).status, 404);
    assert.equal((await f.lookup('123')).status, 400);
  } finally { f.db.close(); }
});

test('production report lookup requires a valid session while local lookup stays available', async () => {
  const f = fixture();
  try {
    const code = (await (await f.publish(f.stage())).json()).data.code;
    const anonymous = await f.lookup(code, '');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('cache-control'), 'no-store');
    assert.equal((await f.lookup(code, 'b'.repeat(43))).status, 401);
    assert.equal((await f.lookup(code)).status, 200);
    f.db.prepare('UPDATE auth_sessions SET expires_at_ms = 0').run();
    assert.equal((await f.lookup(code)).status, 401);
    f.env.APP_RUNTIME = 'node';
    f.env.LLM_RUNTIME = 'local';
    assert.equal((await f.lookup(code, '')).status, 200);
  } finally { f.db.close(); }
});

test('missing objects and corrupt content cannot become visible', async () => {
  const f = fixture();
  try {
    const body = f.stage();
    f.objects.delete(`featured-reports/${body.reportId}/original.pdf`);
    assert.equal((await f.publish(body)).status, 400);
    f.stage();
    f.objects.set(`featured-reports/${body.reportId}/${body.contentHash}/content.json`, '{}');
    assert.equal((await f.publish(body)).status, 400);
    assert.equal(f.db.prepare('select count(*) as n from featured_reports').get().n, 0);
  } finally { f.db.close(); }
});

test('concurrent identical publishes retain one identity and conflicting revisions cannot overwrite each other', async () => {
  const f = fixture();
  try {
    const body = f.stage();
    const results = await Promise.all(Array.from({ length: 8 }, async () => (await (await f.publish(body)).json()).data.code));
    assert.equal(new Set(results).size, 1);
    const a = { ...f.stage('one', 'revision A'), expectedHash: body.contentHash };
    const b = { ...f.stage('one', 'revision B'), expectedHash: body.contentHash };
    const statuses = (await Promise.all([f.publish(a), f.publish(b)])).map(r => r.status).sort();
    assert.deepEqual(statuses, [200, 409]);
  } finally { f.db.close(); }
});

test('database collision retries allocate a different code without overwriting existing reports', async t => {
  const f = fixture();
  let i = 0;
  t.mock.method(globalThis.crypto, 'getRandomValues', array => { array[0] = i++ < 2 ? 0 : 1; return array; });
  try {
    const a = (await (await f.publish(f.stage('one'))).json()).data.code;
    const b = (await (await f.publish(f.stage('two'))).json()).data.code;
    assert.equal(a, '100000'); assert.equal(b, '100001');
    assert.equal(f.db.prepare('select count(*) as n from featured_reports').get().n, 2);
  } finally { f.db.close(); }
});

test('content rejects duplicate blocks, missing translation and invalid PDF coordinates', () => {
  const content = { schemaVersion: 1, reportId: 'a'.repeat(64), title: '报告', institution: '', reportDate: '', pageCount: 1, summary: '总结',
    sections: [{ id: 's1', title: '正文', blocks: [{ id: 'b1', translation: '译文', sourceLocations: [{ page: 1, bbox: [.1, .2, .8, .9] }] }] }] };
  validateContent(content);
  const missing = structuredClone(content); missing.sections[0].blocks[0].translation = '';
  assert.throws(() => validateContent(missing));
  const duplicate = structuredClone(content); duplicate.sections[0].blocks.push(duplicate.sections[0].blocks[0]);
  assert.throws(() => validateContent(duplicate));
  const page = structuredClone(content); page.sections[0].blocks[0].sourceLocations[0].page = 2;
  assert.throws(() => validateContent(page));
});
