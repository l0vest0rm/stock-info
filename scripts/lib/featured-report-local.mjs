// Node-only preview registry. Never imported by the Cloudflare router.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { readJson } from './featured-report-files.mjs';
import { validateContent } from '../../src/modules/featured-reports/domain/content.ts';
import { createReviewHandler } from './featured-report-review.mjs';

const registryPath = () => join(process.env.FEATURED_PROJECT_ROOT || process.cwd(), 'data/local/featured-reports');
export function registerLocalReport(directory, registry = registryPath()) {
  const dir = resolve(directory);
  validateContent(readJson(join(dir, 'content.json')));
  mkdirSync(registry, { recursive: true });
  for (const file of readdirSync(registry)) {
    if (!/^[1-9]\d{5}\.json$/.test(file)) continue;
    if (readJson(join(registry, file)).dir === dir) return { code: file.slice(0, 6), dir };
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = String(randomInt(100000, 1000000));
    try {
      writeFileSync(join(registry, `${code}.json`), JSON.stringify({ dir }), { flag: 'wx' });
      return { code, dir };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('本地研报码分配失败');
}

export function createLocalReportHandler(port, registry = registryPath()) {
  const handlers = new Map();
  return async (req, res) => {
    const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
    const match = pathname.match(/^\/api\/featured-reports\/([1-9]\d{5})$/)
      || pathname.match(/^\/__review\/([1-9]\d{5})\/(?:save|original\.pdf|content\.json)$/);
    if (!match) return false;
    const code = match[1];
    let dir;
    try { ({ dir } = JSON.parse(readFileSync(join(registry, `${code}.json`), 'utf8'))); }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    // Local files use the same read-only metadata contract as the production API.
    if (!handlers.has(dir)) handlers.set(dir, createReviewHandler(dir, port, code, `/__review/${code}`));
    await handlers.get(dir)(req, res);
    return true;
  };
}
