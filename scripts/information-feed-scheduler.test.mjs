import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startInformationFeedScheduler } from './information-feed-scheduler.mjs';

async function withConfig(config, run) {
  const dir = mkdtempSync(join(tmpdir(), 'information-feed-scheduler-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ automation: { enabled: true, cron: '0 0 1 1 *', ...config } }));
  try { return await run(file); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('local feed schedule collects CLS then ingests/tags without publishing by default', async () => {
  await withConfig({}, async (configPath) => {
    const calls = [];
    const scheduler = startInformationFeedScheduler({ configPath, runChild: async (call) => { calls.push(call); } });
    try {
      assert.equal(await scheduler.runNow('test'), true);
      assert.deepEqual(calls.map((call) => call.command), ['node', './process-information-feed-local.sh']);
      assert.deepEqual(calls[1].args.slice(-2), ['--max-age-hours', '48']);
    } finally { scheduler.stop(); }
  });
});

test('CLS collector failure does not block Tencent file processing', async () => {
  await withConfig({}, async (configPath) => {
    const calls = [];
    const scheduler = startInformationFeedScheduler({ configPath, runChild: async (call) => {
      calls.push(call.command);
      if (calls.length === 1) throw new Error('CLS down');
    } });
    try {
      assert.equal(await scheduler.runNow('test'), true);
      assert.deepEqual(calls, ['node', './process-information-feed-local.sh']);
    } finally { scheduler.stop(); }
  });
});
