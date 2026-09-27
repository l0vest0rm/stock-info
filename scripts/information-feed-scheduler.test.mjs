import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startInformationFeedScheduler } from './information-feed-scheduler.mjs';

async function withScheduler(config, run) {
  const dir = mkdtempSync(join(tmpdir(), 'information-feed-scheduler-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ automation: { enabled: true, runOnStart: false,
    changeDebounceMs: 1, ...config } }));
  const previous = process.env.INFORMATION_FEED_INPUT_DIR;
  process.env.INFORMATION_FEED_INPUT_DIR = dir;
  let changed;
  let poll;
  let closed = false;
  const scheduler = startInformationFeedScheduler({ configPath: file,
    runChild: config.runChild,
    watchFiles: (_dir, _options, callback) => { changed = callback; return { close() { closed = true; } }; },
    setTimer: (callback) => { poll = callback; return 1; }, clearTimer: () => {},
  });
  try { await run({ scheduler, changed: (name) => changed('change', name), poll: () => poll(), isClosed: () => closed }); }
  finally {
    scheduler.stop();
    if (previous === undefined) delete process.env.INFORMATION_FEED_INPUT_DIR;
    else process.env.INFORMATION_FEED_INPUT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test('feed processing follows file changes; an unchanged CLS poll does not process', async () => {
  const calls = [];
  await withScheduler({ runChild: async ({ command }) => { calls.push(command); } }, async ({ scheduler, changed, poll, isClosed }) => {
    poll();
    await tick();
    assert.deepEqual(calls, ['node']);
    changed('new.jsonl');
    await tick();
    assert.deepEqual(calls, ['node', './process-information-feed-local.sh']);
    changed('ignored.tmp');
    await tick();
    assert.equal(calls.length, 2);
    assert.equal(await scheduler.runNow('test'), true);
    assert.deepEqual(calls.slice(-2), ['node', './process-information-feed-local.sh']);
    scheduler.stop();
    assert.equal(isClosed(), true);
  });
});

test('changes arriving during processing are drained after the active run', async () => {
  const calls = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  await withScheduler({ runChild: async ({ command }) => {
    calls.push(command);
    if (command === './process-information-feed-local.sh' && calls.length === 1) await blocked;
  } }, async ({ changed }) => {
    changed('a.json');
    await tick();
    changed('b.json');
    await tick();
    release();
    await tick();
    assert.deepEqual(calls, ['./process-information-feed-local.sh', './process-information-feed-local.sh']);
  });
});

test('a full extraction batch immediately continues without waiting for another file event', async () => {
  let batches = 0;
  await withScheduler({ maxTagsPerRun: 2, runChild: async ({ command, args }) => {
    if (command === 'node') return { stdout: '' };
    assert.deepEqual(args.slice(2, 4), ['--max-tags', '2']);
    batches += 1;
    return { stdout: JSON.stringify({ tagged: batches === 1 ? 2 : 0, tagFailed: 0 }) };
  } }, async ({ scheduler }) => {
    assert.equal(await scheduler.runNow('test'), true);
    assert.equal(batches, 2);
  });
});
