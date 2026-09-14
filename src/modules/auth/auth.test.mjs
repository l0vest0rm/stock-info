import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono } from 'hono';
import { authRoutes, safeReturnPath } from './auth.ts';
import { randomId, sha256 } from './crypto.ts';
import { knowledgeRoutes } from '../knowledge/api/knowledge.routes.ts';

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../../migrations/0139_auth_accounts.sql', import.meta.url), 'utf8'));
  sqlite.exec('CREATE TABLE knowledge_docs(doc_id TEXT, url TEXT, source_type TEXT, report_type TEXT)');
  t.after(() => sqlite.close());
  const DB = {
    prepare(sql) {
      return {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() { return sqlite.prepare(sql).get(...this.values) || null; },
        async run() { const result = sqlite.prepare(sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = statements.map((statement) => ({ meta: { changes: Number(sqlite.prepare(statement.sql).run(...statement.values).changes) } })); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const env = { DB, APP_RUNTIME: 'cloudflare', AUTH_LOGIN_LIMITER: { limit: async () => ({ success: true }) }, AUTH_RESET_LIMITER: { limit: async () => ({ success: true }) } };
  const app = new Hono().route('/api', authRoutes).route('/api', knowledgeRoutes);
  const request = (path, options = {}) => app.request(`https://tinfo.cc${path}`, options, env);
  const post = (path, body, cookie) => request(`/api/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  return { sqlite, env, request, post };
}

test('registration, login, logout and expiry enforce server sessions', async (t) => {
  const { sqlite, request, post } = fixture(t);
  assert.equal((await request('/api/auth/me')).status, 200);
  const initial = await post('login', { email: 'Reader@EXAMPLE.com', password: 'first-password' });
  assert.deepEqual(await initial.json(), { requires_password_confirmation: true });
  assert.equal(initial.headers.get('set-cookie'), null);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM users').get().n, 0);
  assert.equal((await post('login', { email: 'Reader@EXAMPLE.com', password: 'first-password', password_confirmation: 'different-password' })).status, 400);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM users').get().n, 0);
  const registered = await post('login', { email: 'Reader@EXAMPLE.com', password: 'first-password', password_confirmation: 'first-password' });
  assert.equal(registered.status, 200);
  const header = registered.headers.get('set-cookie');
  assert.match(header, /HttpOnly/); assert.match(header, /Secure/); assert.match(header, /SameSite=Lax/);
  const cookie = header.split(';')[0];
  const user = (await registered.json()).user;
  assert.equal(user.email, 'reader@example.com');
  assert.equal(sqlite.prepare('SELECT password_hash FROM users').get().password_hash.startsWith('pbkdf2-sha256$'), true);
  assert.equal((await post('login', { email: user.email, password: 'wrong-password' })).status, 401);
  assert.equal((await post('login', { email: user.email, password: 'another-password', password_confirmation: 'another-password' })).status, 401);
  sqlite.prepare('INSERT INTO knowledge_docs VALUES (?, ?, ?, ?)').run('report1', 'https://pdf.dfcfw.com/one.pdf', 'research_report', 'company_report');
  sqlite.prepare('INSERT INTO knowledge_docs VALUES (?, ?, ?, ?)').run('news1', 'https://example.com/news', 'web_news', 'news');
  assert.match((await request('/api/knowledge/file?id=report1')).headers.get('location'), /^\/login.html/);
  assert.equal((await request('/api/knowledge/file?id=report1', { headers: { cookie } })).headers.get('location'), 'https://pdf.dfcfw.com/one.pdf');
  assert.equal((await request('/api/knowledge/file?id=news1')).headers.get('location'), 'https://example.com/news');
  await post('logout', {}, cookie);
  assert.equal((await (await request('/api/auth/me', { headers: { cookie } })).json()).user, null);
  const login = await post('login', { email: user.email, password: 'first-password' });
  const nextCookie = login.headers.get('set-cookie').split(';')[0];
  sqlite.exec('UPDATE auth_sessions SET expires_at_ms = 0');
  assert.match((await request('/api/knowledge/file?id=report1', { headers: { cookie: nextCookie } })).headers.get('location'), /^\/login.html/);
});

test('reset token is single-use, expires, revokes all sessions and works with no sessions', async (t) => {
  const { sqlite, post, request } = fixture(t);
  const registered = await post('login', { email: 'reset@example.com', password: 'first-password', password_confirmation: 'first-password' });
  const cookie = registered.headers.get('set-cookie').split(';')[0];
  const token = randomId();
  sqlite.prepare('UPDATE users SET reset_token_hash = ?, reset_expires_at_ms = ?').run(await sha256(token), Date.now() + 60_000);
  assert.equal((await post('password-reset/confirm', { token, password: 'second-password' })).status, 200);
  assert.equal(sqlite.prepare('SELECT reset_token_hash FROM users').get().reset_token_hash, null);
  assert.equal((await (await request('/api/auth/me', { headers: { cookie } })).json()).user, null);
  assert.equal((await post('password-reset/confirm', { token, password: 'third-password' })).status, 400);
  assert.equal((await post('login', { email: 'reset@example.com', password: 'first-password' })).status, 401);
  assert.equal((await post('login', { email: 'reset@example.com', password: 'second-password' })).status, 200);
  const expired = randomId();
  sqlite.prepare('UPDATE users SET reset_token_hash = ?, reset_expires_at_ms = ?').run(await sha256(expired), Date.now() - 1);
  assert.equal((await post('password-reset/confirm', { token: expired, password: 'expired-password' })).status, 400);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 1);
  const nextToken = randomId();
  sqlite.prepare('UPDATE users SET reset_token_hash = ?, reset_expires_at_ms = ?').run(await sha256(nextToken), Date.now() + 60_000);
  sqlite.exec('DELETE FROM auth_sessions');
  assert.equal((await post('password-reset/confirm', { token: nextToken, password: 'last-password' })).status, 200);
  const racedToken = randomId();
  sqlite.prepare('UPDATE users SET reset_token_hash = ?, reset_expires_at_ms = ?').run(await sha256(racedToken), Date.now() + 60_000);
  const raced = await Promise.all([
    post('password-reset/confirm', { token: racedToken, password: 'race-one-password' }),
    post('password-reset/confirm', { token: racedToken, password: 'race-two-password' }),
  ]);
  assert.deepEqual(raced.map((response) => response.status).sort(), [200, 400]);
});

test('cross-site writes, rate limits and unsafe return URLs are rejected', async (t) => {
  const { env, request, post } = fixture(t);
  const response = await request('/api/auth/register', { method: 'POST', headers: { origin: 'https://other.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);
  env.AUTH_LOGIN_LIMITER.limit = async () => ({ success: false });
  assert.equal((await post('login', {})).status, 429);
  env.AUTH_RESET_LIMITER.limit = async () => ({ success: false });
  assert.equal((await post('password-reset/request', {})).status, 429);
  for (const value of ['//evil.example', '/\\evil.example', 'https://evil.example', '/login.html', '/\nevil']) assert.equal(safeReturnPath(value), '/');
  assert.equal(safeReturnPath('/api/knowledge/file?id=one'), '/api/knowledge/file?id=one');
});
