import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as parseJsonc } from 'jsonc-parser';
import { root, hash, readJson, writeJson, loadCredentials, checkCoverage } from './lib/featured-report-files.mjs';
import { validateContent, MAX_CONTENT_BYTES } from '../src/modules/featured-reports/domain/content.ts';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) { console.log('Usage: ./publish-featured-report.sh DIR [--base-url https://tinfo.cc]'); process.exit(0); }
loadCredentials();
const dir = resolve(args[0]);
const contentBytes = readFileSync(join(dir, 'content.json'));
if (contentBytes.length > MAX_CONTENT_BYTES) throw new Error('Content JSON exceeds 12 MiB');
const content = validateContent(JSON.parse(contentBytes));
const contentHash = hash(contentBytes);
checkCoverage(content, readJson(join(dir, 'source.json')));
const pdf = readFileSync(join(dir, 'original.pdf'));
if (hash(pdf) !== content.reportId) throw new Error('PDF checksum mismatch');
if (!process.env.REPORT_SYNC_TOKEN) throw new Error('Missing REPORT_SYNC_TOKEN in .dev.vars');
if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('Missing CLOUDFLARE_API_TOKEN');
const baseIndex = args.indexOf('--base-url');
const base = (baseIndex >= 0 ? args[baseIndex+1] : 'https://tinfo.cc')?.replace(/\/$/, '');
if (!base || new URL(base).protocol !== 'https:') throw new Error('Publication requires HTTPS');
const receiptFile = join(dir, 'published.json');
const previous = existsSync(receiptFile) ? readJson(receiptFile) : null;
if (previous && previous.base !== base) throw new Error('Publication receipt belongs to another environment');
const prefix = `featured-reports/${content.reportId}`;
const config = parseJsonc(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
const database = config.d1_databases?.find(db => db.binding === 'DB')?.database_name;
const publicBase = config.vars?.KNOWLEDGE_CONTENT_PUBLIC_BASE_URL?.replace(/\/$/, '');
if (!database || !publicBase) throw new Error('Missing DB or KNOWLEDGE_CONTENT_PUBLIC_BASE_URL in wrangler.jsonc');
const bucket = process.env.KNOWLEDGE_CONTENT_BUCKET || 'stock-info-knowledge-content';
for (const [file, key, type] of [
  ['original.pdf', `${prefix}/original.pdf`, 'application/pdf'],
  ['content.json', `${prefix}/${contentHash}/content.json`, 'application/json; charset=utf-8'],
]) {
  if (previous && (file === 'original.pdf' || previous.contentHash === contentHash)) continue;
  console.log(`上传 ${file}`);
  execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `${bucket}/${key}`, '--remote', '--file', join(dir, file), '--content-type', type, '--cache-control', 'public, max-age=31536000, immutable', '--force'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
}
const response = await fetch(`${base}/api/internal/featured-reports`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.REPORT_SYNC_TOKEN}` },
  body: JSON.stringify({ reportId: content.reportId, contentHash, expectedHash: previous?.contentHash || null }), signal: AbortSignal.timeout(60000) });
const result = await response.json();
if (!response.ok || !result.data?.code) throw new Error(`Publication failed: ${result.msg || response.status}`);
// Persist the successful commit before checking the public CDN, so retries never change code.
writeJson(receiptFile, { base, code: result.data.code, contentHash });
// Reader lookup requires a login session. Verify the committed index with the
// publisher's Cloudflare credentials instead of weakening reader authentication.
const query = `SELECT code, content_hash, content_key, pdf_key, status FROM featured_reports WHERE report_id = '${content.reportId}'`;
const output = execFileSync('npx', ['wrangler', 'd1', 'execute', database, '--remote', '--command', query, '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const row = JSON.parse(output)[0]?.results?.[0];
if (row?.code !== result.data.code || row?.content_hash !== contentHash || row?.status !== 'published'
  || row?.content_key !== `${prefix}/${contentHash}/content.json` || row?.pdf_key !== `${prefix}/original.pdf`) {
  throw new Error(`Published index verification failed for report ${result.data.code}: remote D1 record is missing, withdrawn, or differs from the submitted report`);
}
const [published, publishedPdf] = await Promise.all([
  fetch(`${publicBase}/${row.content_key}`, { signal: AbortSignal.timeout(60000) }),
  fetch(`${publicBase}/${row.pdf_key}`, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(60000) }),
]);
if (!published.ok || hash(Buffer.from(await published.arrayBuffer())) !== contentHash || !publishedPdf.ok) throw new Error('Published R2 resources not yet readable; retry publication');
await publishedPdf.body?.cancel();
console.log(`研报码：${result.data.code}\n阅读地址：${base}/featured-report.html?code=${result.data.code}`);
