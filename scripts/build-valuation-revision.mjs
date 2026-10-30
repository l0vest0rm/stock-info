import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(resolve(dir, e.name)) : /\.(ts|rs|json)$/.test(e.name) ? [resolve(dir, e.name)] : []);
}
// Conservative dependency closure: invalidate rather than serve a result made
// with old adapter/financial/domain logic. No timestamps or secrets are inputs.
const inputs = [...files(resolve(root, 'backend/src')), ...files(resolve(root, 'shared')),
  resolve(root, 'backend/Cargo.toml'), resolve(root, 'backend/Cargo.lock'),
  ...files(resolve(root, 'config/research')), resolve(root, 'config/generated/eastmoney-company-em2016-profiles.json'),
  resolve(root, 'config/investment-universe.json'), resolve(root, 'config/investment-opportunity-policy.json')].sort();
const hash = createHash('sha256');
for (const path of inputs) hash.update(relative(root, path)).update('\0').update(readFileSync(path)).update('\0');
const output = JSON.stringify({ revision: hash.digest('hex') }, null, 2) + '\n';
const target = resolve(root, 'config/generated/valuation-revision.json');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== output) throw new Error('valuation revision is stale; run npm run build:prompts');
} else writeFileSync(target, output);
