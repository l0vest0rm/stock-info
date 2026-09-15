#!/usr/bin/env node
// Live acceptance: optional FEATURED_SMOKE_CODE exercises already-published resources.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const base = (process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const get = (path, init = {}) => fetch(new URL(path, base), { ...init, signal: AbortSignal.timeout(30000) });
const health = await get('/api/health'); assert.equal(health.status, 200);
const page = await get('/featured-report.html'); assert.equal(page.status, 200);
assert.match(await page.text(), /featured-report-root/);
const entry = await get('/js/featured-report-page.js'); assert.equal(entry.status, 200);
const entryText = await entry.text();
assert.match(entryText, /研报精选/);
const workerPath = entryText.match(/\/assets\/pdf\.worker-[^"'`\s]+\.mjs/)?.[0];
assert.ok(workerPath, 'PDF worker asset must be bundled');
const worker = await get(workerPath);
assert.equal(worker.status, 200);
assert.match(worker.headers.get('content-type'), /javascript/);
await worker.body.cancel();
assert.equal((await get('/api/featured-reports/abc')).status, 400);
assert.equal((await get('/api/internal/featured-reports', { method: 'POST', body: '{}' })).status, 401);
const code = process.env.FEATURED_SMOKE_CODE;
if (code) {
  const index = await get(`/api/featured-reports/${code}`); assert.equal(index.status, 200);
  assert.equal(index.headers.get('cache-control'), 'no-store');
  const { data } = await index.json();
  const json = await get(data.contentUrl); assert.equal(json.status, 200);
  const bytes = Buffer.from(await json.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), data.contentHash);
  const content = JSON.parse(bytes); assert.ok(content.summary); assert.ok(content.sections.length);
  const pdf = await get(data.pdfUrl, { headers: { Range: 'bytes=0-1023', Origin: new URL(base).origin } });
  assert.equal(pdf.status, 206); assert.match(pdf.headers.get('content-type'), /application\/pdf/);
  assert.ok(Buffer.from(await pdf.arrayBuffer()).includes(Buffer.from('%PDF-')));
  if (new URL(data.pdfUrl, base).origin !== new URL(base).origin) assert.ok(['*', new URL(base).origin].includes(pdf.headers.get('access-control-allow-origin')));
  console.log(`Report ${code}: JSON checksum, source PDF Range/CORS and metadata verified.`);
}
console.log(`Featured report live smoke passed: ${base}`);
