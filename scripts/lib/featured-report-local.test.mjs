import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { registerLocalReport, createLocalReportHandler } from './featured-report-local.mjs';

test('local codes survive handler restart and scope artifacts and read-only access', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'featured-local-'));
  const dir = join(temp, 'report');
  mkdirSync(dir);
  const pdf = Buffer.from('%PDF-1.7 synthetic fixture');
  const sourceLocations = [{ page: 1, bbox: [0.1, 0.1, 0.9, 0.2] }];
  const source = { sections: [{ id: 's1', title: 'Research', blocks: [{ id: 'b1', original: 'Revenue grows', sourceLocations }] }] };
  const content = { schemaVersion: 1, reportId: createHash('sha256').update(pdf).digest('hex'), title: 'Test', institution: '', reportDate: '', pageCount: 1, summary: 'Summary', sections: [{ id: 's1', title: 'Research', blocks: [{ id: 'b1', translation: '收入增长', sourceLocations }] }] };
  writeFileSync(join(dir, 'original.pdf'), pdf);
  writeFileSync(join(dir, 'source.json'), JSON.stringify(source));
  writeFileSync(join(dir, 'content.json'), JSON.stringify(content));
  const registry = join(temp, 'registry');
  let server;
  try {
    const { code } = registerLocalReport(dir, registry);
    assert.match(code, /^[1-9]\d{5}$/);
    assert.equal(registerLocalReport(dir, registry).code, code);
    let handler;
    server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    handler = createLocalReportHandler(port, registry);
    const origin = `http://127.0.0.1:${port}`;
    const record = (await (await fetch(`${origin}/api/featured-reports/${code}`)).json()).data;
    const content = await (await fetch(origin + record.contentUrl)).json();
    assert.ok(content.sections.length);
    assert.equal((await fetch(origin + record.pdfUrl, { headers: { Range: 'bytes=0-3' } })).status, 206);
    assert.equal(record.review, undefined);
    assert.equal(record.code, code);
    assert.equal((await fetch(`${origin}/__review/${code}/save`, { method: 'POST', body: '{}' })).status, 405);
    handler = createLocalReportHandler(port, registry);
    assert.equal((await fetch(`${origin}/api/featured-reports/${code}`)).status, 200);
    assert.equal((await fetch(`${origin}/api/featured-reports/100000`)).status, 404);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); rmSync(temp, { recursive: true, force: true }); }
});
