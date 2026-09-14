import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
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
if (readJson(join(dir, 'review.json')).approvedHash !== contentHash) throw new Error('内容尚未审阅确认，或审阅后文件发生变化；请使用 --review 审阅并确认');
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
const lookup = await fetch(`${base}/api/featured-reports/${result.data.code}`).then(r => r.json());
if (lookup.data?.contentHash !== contentHash) throw new Error('Public index verification failed');
const [published, publishedPdf] = await Promise.all([fetch(lookup.data.contentUrl), fetch(lookup.data.pdfUrl, { headers: { Range: 'bytes=0-1023' } })]);
if (!published.ok || hash(Buffer.from(await published.arrayBuffer())) !== contentHash || !publishedPdf.ok) throw new Error('Published R2 resources not yet readable; retry publication');
await publishedPdf.body?.cancel();
console.log(`研报码：${result.data.code}\n阅读地址：${base}/featured-report.html?code=${result.data.code}`);
