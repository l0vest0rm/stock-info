import { watch, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Ingestion is driven by source-file changes. CLS has no push endpoint, so only
// its collection remains a bounded poll; an unchanged fetch does not run the feed.
export function startInformationFeedScheduler({
  configPath = resolve('config/information-feed.json'), runChild, onEvent = () => {},
  watchFiles = watch, setTimer = setInterval, clearTimer = clearInterval,
}) {
  const config = JSON.parse(readFileSync(configPath, 'utf8')).automation || {};
  if (config.enabled !== true) return { stop() {}, runNow: async () => false };
  const inputDir = resolve(process.env.INFORMATION_FEED_INPUT_DIR || '/Users/terry/git/data/news');
  mkdirSync(inputDir, { recursive: true });
  let active = false;
  let dirty = false;
  let stopping = false;
  let debounce = null;
  let retry = null;
  let quotaReset = null;

  const processChanges = async (reason) => {
    if (stopping) return false;
    if (active) { dirty = true; return false; }
    active = true;
    try {
      do {
        dirty = false;
        const output = await runChild({ command: './process-information-feed-local.sh', args: [
          '--max-documents', String(config.maxDocumentsPerRun || 10000),
          '--max-tags', String(config.maxTagsPerRun || 20),
          '--lookback-days', String(config.lookbackDays || 3),
          '--max-age-hours', String(config.maxAgeHours || 48),
        ], cwd: resolve('.'), env: process.env });
        const counters = parseFeedCounters(output?.stdout);
        if (config.publishRemote === true) await runChild({ command: 'node', args: ['scripts/publish-information-feed.mjs', '--apply'], cwd: resolve('.'), env: process.env });
        onEvent('completed', { reason });
        if ((counters?.tagged || 0) + (counters?.tagFailed || 0) >= (config.maxTagsPerRun || 20)) dirty = true;
        scheduleQuotaReset();
      } while (dirty && !stopping);
      if (retry) { clearTimeout(retry); retry = null; }
      return true;
    } catch (error) {
      onEvent('failed', { reason, error: String(error) });
      if (!stopping && !retry) retry = setTimeout(() => {
        retry = null;
        void processChanges('retry');
      }, (config.retrySeconds || 30) * 1000);
      return false;
    } finally { active = false; }
  };

  const collect = async (reason) => {
    if (stopping) return;
    try {
      await runChild({ command: 'node', args: ['scripts/fetch-cls-news.mjs'], cwd: resolve('.'), env: process.env });
    } catch (error) { onEvent('cls_fetch_failed', { reason, error: String(error) }); }
  };
  const runNow = async (reason = 'manual') => {
    await collect(reason);
    return processChanges(reason);
  };
  function scheduleQuotaReset() {
    const usageFile = resolve(process.env.INFORMATION_FEED_TAG_USAGE_FILE || 'data/local/information-feed-tag-usage.json');
    if (!existsSync(usageFile)) return;
    let usage;
    try { usage = JSON.parse(readFileSync(usageFile, 'utf8')); } catch { return; }
    const now = new Date();
    if (usage.day !== now.toISOString().slice(0, 10) || Number(usage.count) < (config.maxTagsPerDay || 500)) return;
    if (quotaReset) return;
    const nextDay = Date.parse(`${new Date(now.getTime() + 86400000).toISOString().slice(0, 10)}T00:00:00Z`);
    quotaReset = setTimeout(() => { quotaReset = null; void processChanges('quota_reset'); }, nextDay - now.getTime() + 1000);
    onEvent('quota_reset_scheduled', { due_in_ms: nextDay - now.getTime() + 1000 });
  }
  const watcher = watchFiles(inputDir, { recursive: true }, (_event, filename) => {
    if (stopping || !filename || !/\.jsonl?$/i.test(String(filename))) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; void processChanges('source_changed'); }, config.changeDebounceMs || 300);
  });
  watcher.on?.('error', (error) => onEvent('watch_failed', { error: String(error) }));
  const collector = setTimer(() => { void collect('poll'); }, (config.clsPollSeconds || 60) * 1000);
  if (config.runOnStart) void runNow('startup');
  onEvent('watching', { inputDir, clsPollSeconds: config.clsPollSeconds || 60, publishRemote: config.publishRemote === true });
  return { runNow, stop() {
    stopping = true;
    watcher.close();
    clearTimer(collector);
    if (debounce) clearTimeout(debounce);
    if (retry) clearTimeout(retry);
    if (quotaReset) clearTimeout(quotaReset);
  } };
}

function parseFeedCounters(output) {
  const line = String(output || '').trim().split(/\r?\n/).at(-1);
  try { return JSON.parse(line); } catch { return null; }
}
