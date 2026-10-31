import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

test('model-only switches preserve exact historical provenance and generate idempotently', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'stock-llm-contract-'));
  try {
    for (const path of ['scripts/build-prompts.mjs', 'config/knowledge', 'config/app/llm.json',
      'config/generated/information-records-contract.json', 'prompts/information-feed']) {
      mkdirSync(dirname(resolve(root, path)), { recursive: true });
      cpSync(new URL(`../${path}`, import.meta.url), resolve(root, path), { recursive: true });
    }
    mkdirSync(resolve(root, 'web/src/config'), { recursive: true });
    const run = () => execFileSync(process.execPath, [resolve(root, 'scripts/build-prompts.mjs')]);
    const manifest = () => JSON.parse(readFileSync(resolve(root, 'config/generated/information-records-contract.json'), 'utf8'));
    run();
    const original = manifest().current;
    const configPath = resolve(root, 'config/app/llm.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.model = 'gpt-config-only-test';
    config.protocol = 'responses';
    writeFileSync(configPath, JSON.stringify(config));
    run();
    assert.equal(manifest().current.model, config.model);
    assert.ok(manifest().legacy.some((entry) => JSON.stringify(entry) === JSON.stringify(original)));
    const snapshot = JSON.stringify(manifest());
    run();
    assert.equal(JSON.stringify(manifest()), snapshot);
    config.model = original.model;
    writeFileSync(configPath, JSON.stringify(config));
    run();
    assert.deepEqual(manifest().current, original);
    assert.ok(manifest().legacy.some((entry) => entry.model === 'gpt-config-only-test'));
    assert.ok(manifest().legacy.some((entry) => entry.contractVersion === 'feed-tag-v10' && entry.model === 'gpt-6-luna'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
