import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../config');
const projectRoot = resolve(root, '..');

function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : entry.isFile() ? [path] : [];
  });
}

test('config remains grouped and every tracked JSON parses', () => {
  const entries = readdirSync(root, { withFileTypes: true });
  assert.deepEqual(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')
    && !entry.name.endsWith('.local.json')).map((entry) => entry.name), []);
  assert.deepEqual(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
    ['app', 'backtest', 'generated', 'knowledge', 'research']);
  for (const entry of entries.filter((item) => item.isDirectory())) {
    for (const file of readdirSync(resolve(root, entry.name))) {
      if (!file.endsWith('.json') || file.endsWith('.local.json')) continue;
      assert.doesNotThrow(() => JSON.parse(readFileSync(resolve(root, entry.name, file), 'utf8')), `${entry.name}/${file}`);
    }
  }
});

test('feed relevance and whitelist remain one versioned policy', () => {
  const policy = JSON.parse(readFileSync(resolve(root, 'knowledge/information-feed-policy.json'), 'utf8'));
  assert.deepEqual(Object.keys(policy), ['relevance', 'whitelist']);
  assert.ok(policy.relevance.version);
  assert.ok(policy.whitelist.version);
  assert.ok(Array.isArray(policy.relevance.positive));
  assert.ok(policy.whitelist.listed);
});

test('every configuration has a non-test code or deploy consumer', () => {
  const consumers = [
    ...filesIn(resolve(projectRoot, 'src')),
    ...filesIn(resolve(projectRoot, 'scripts')),
    ...filesIn(resolve(projectRoot, 'web/src')),
    ...filesIn(resolve(projectRoot, 'web/scripts')),
    resolve(projectRoot, 'deploy-cloudflare.sh'),
  ].filter((path) => /\.(?:ts|js|mjs|cjs|sh)$/.test(path) && !/\.test\./.test(path));
  const source = consumers.map((path) => readFileSync(path, 'utf8')).join('\n');
  for (const file of filesIn(root).filter((path) => path.endsWith('.json') && !path.endsWith('.local.json'))) {
    const name = relative(projectRoot, file).replaceAll('\\', '/');
    assert.ok(source.includes(name), `orphan configuration: ${name}`);
  }
});
