import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('manual feed publisher cannot bypass the disabled remote switch', (t) => {
  const config = JSON.parse(readFileSync(new URL('../config/information-feed.json', import.meta.url), 'utf8'));
  if (config.automation?.publishRemote === true) {
    t.skip('remote publication is enabled; never exercise a real publish in a unit test');
    return;
  }
  const result = spawnSync(process.execPath, [new URL('./publish-information-feed.mjs', import.meta.url).pathname, '--apply'], {
    encoding: 'utf8',
    env: { ...process.env, LLM_RUNTIME: 'local' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { published: 0, skipped: 'remote publication switch is off' });
});
