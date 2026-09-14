import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { root, hash, readJson, writeJson, checkCoverage } from './featured-report-files.mjs';
import { validateContent, MAX_CONTENT_BYTES } from '../../src/modules/featured-reports/domain/content.ts';

export async function startReviewServer(dir, port) {
  const contentFile = join(dir, 'content.json'); validateContent(readJson(contentFile));
  const token = randomBytes(24).toString('hex');
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf', '.json': 'application/json', '.bcmap': 'application/octet-stream', '.ttf': 'font/ttf' };
  const origin = `http://127.0.0.1:${port}`;
  const server = createServer(async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403); res.end(); return; }
      const url = new URL(req.url, origin);
      if (req.method === 'POST' && url.pathname === '/__review/save') {
        if (req.headers.origin !== origin || req.headers['x-review-token'] !== token) { res.writeHead(403); res.end(); return; }
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > MAX_CONTENT_BYTES) throw new Error('Content too large'); chunks.push(chunk); }
        const request = JSON.parse(Buffer.concat(chunks));
        const currentHash = hash(readFileSync(contentFile));
        if (request.expectedHash !== currentHash) { res.writeHead(409); res.end('文件已被修改，请刷新后再保存'); return; }
        const content = validateContent(request.content);
        if (content.reportId !== hash(readFileSync(join(dir, 'original.pdf')))) throw new Error('PDF identity mismatch');
        checkCoverage(content, readJson(join(dir, 'source.json')));
        writeJson(contentFile, content);
        const contentHash = hash(readFileSync(contentFile));
        writeJson(join(dir, 'review.json'), { approvedHash: request.approve ? contentHash : null, reviewedAt: new Date().toISOString() });
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ contentHash, approved: Boolean(request.approve) })); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      if (url.pathname === '/api/featured-reports/review') {
        const content = readJson(contentFile);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ code: 200, data: { title: content.title, pdfUrl: '/__review/original.pdf', contentUrl: '/__review/content.json',
          contentHash: hash(readFileSync(contentFile)), review: { token, issues: existsSync(join(dir, 'checks.json')) ? readJson(join(dir, 'checks.json')).issues : [] } } })); return;
      }
      const files = { '/__review/original.pdf': join(dir, 'original.pdf'), '/__review/content.json': contentFile };
      const path = url.pathname === '/' ? '/featured-report.html' : decodeURIComponent(url.pathname);
      const dist = join(root, 'web/dist');
      const file = files[path] || resolve(dist, '.' + path);
      if (!files[path] && !file.startsWith(dist + sep)) { res.writeHead(404); res.end(); return; }
      if (!existsSync(file)) { res.writeHead(404); res.end('Not found; run ./start-local.sh to build the review page'); return; }
      const bytes = readFileSync(file);
      res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'bytes');
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) {
        const start = Number(range[1]), end = Math.min(Number(range[2] || bytes.length - 1), bytes.length - 1);
        if (start > end || start >= bytes.length) { res.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }); res.end(); return; }
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end-start+1 });
        res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end+1));
      } else { res.setHeader('Content-Length', bytes.length); res.end(req.method === 'HEAD' ? undefined : bytes); }
    } catch (e) { res.writeHead(400); res.end(e.message); }
  });
  server.listen(port, '127.0.0.1', () => console.log(`本地审阅：${origin}/featured-report.html?code=review`));
  return server;
}
