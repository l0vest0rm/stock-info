import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Cron } from 'croner';

export function startInformationFeedScheduler({
  configPath = resolve('config/information-feed.json'), runChild, onEvent = () => {},
}) {
  const config = JSON.parse(readFileSync(configPath, 'utf8')).automation || {};
  if (config.enabled !== true) return { stop() {}, runNow: async () => false };
  let active = false;
  let stopping = false;
  const runNow = async (reason) => {
    if (stopping || active) return false;
    active = true;
    try {
      try {
        await runChild({ command: 'node', args: ['scripts/fetch-cls-news.mjs'], cwd: resolve('.'), env: process.env });
      } catch (error) {
        onEvent('cls_fetch_failed', { reason, error: String(error) });
      }
      await runChild({ command: './process-information-feed-local.sh', args: [
        '--max-documents', String(config.maxDocumentsPerRun || 200),
        '--max-tags', String(config.maxTagsPerRun || 20),
        '--lookback-days', String(config.lookbackDays || 14),
        '--max-age-hours', String(config.maxAgeHours || 48),
      ], cwd: resolve('.'), env: process.env });
      if (config.publishRemote === true) await runChild({ command: 'node', args: ['scripts/publish-information-feed.mjs', '--apply'], cwd: resolve('.'), env: process.env });
      onEvent('completed', { reason });
      return true;
    } catch (error) {
      onEvent('failed', { reason, error: String(error) });
      return false;
    } finally { active = false; }
  };
  const job = new Cron(config.cron || '*/15 * * * *', { timezone: 'Asia/Shanghai' }, () => { void runNow('schedule'); });
  if (config.runOnStart) void runNow('startup');
  onEvent('scheduled', { cron: config.cron, publishRemote: config.publishRemote === true });
  return { runNow, stop() { stopping = true; job.stop(); } };
}
