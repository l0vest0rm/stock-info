import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { root, hash, readJson } from './featured-report-files.mjs';
import { validateContent } from '../../src/modules/featured-reports/domain/content.ts';

export function createReviewHandler(dir, port, code = '100000', prefix = '/__review') {
  const contentFile = join(dir, 'content.json'); validateContent(readJson(contentFile));
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.pdf': 'application/pdf', '.json': 'application/json', '.bcmap': 'application/octet-stream', '.ttf': 'font/ttf' };
  const origin = `http://127.0.0.1:${port}`;
  return async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403); res.end(); return; }
      const url = new URL(req.url, origin);
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      if (url.pathname === `/api/featured-reports/${code}`) {
        const content = readJson(contentFile);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ code: 200, data: { code, title: content.title, institution: content.institution, reportDate: content.reportDate, pdfUrl: `${prefix}/original.pdf`, contentUrl: `${prefix}/content.json`,
          contentHash: hash(readFileSync(contentFile)) } })); return;
      }
      const files = { [`${prefix}/original.pdf`]: join(dir, 'original.pdf'), [`${prefix}/content.json`]: contentFile };
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
  };
}

export async function startReviewServer(dir, port) {
  const origin = `http://127.0.0.1:${port}`;
  const server = createServer(createReviewHandler(dir, port));
  server.listen(port, '127.0.0.1', () => console.log(`本地审阅：${origin}/featured-report.html?code=100000`));
  return server;
}
