#!/usr/bin/env node

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(new URL('..', import.meta.url).pathname);
const directory = mkdtempSync(join(tmpdir(), 'stock-info-information-tests-'));
try {
  execFileSync(process.execPath, ['scripts/build-prompts.mjs'], { cwd: root, stdio: 'inherit' });
  const bundle = join(directory, 'information-feed.routes.mjs');
  await build({ absWorkingDir: root, entryPoints: ['src/modules/knowledge/api/information-feed.routes.ts'],
    outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'warning' });
  execFileSync(process.execPath, ['--test',
    'scripts/lib/information-records-store.test.mjs',
    'scripts/lib/information-records-backfill.test.mjs',
    'scripts/lib/information-records-publish.test.mjs',
    'scripts/lib/information-records-reconcile.test.mjs',
    'scripts/information-records-migration.test.mjs',
    'scripts/check-no-new-tables.test.mjs',
    'src/modules/knowledge/api/information-records.routes.test.mjs'], {
    cwd: root, stdio: 'inherit', env: { ...process.env, INFORMATION_RECORDS_API_BUNDLE: pathToFileURL(bundle).href },
  });
} finally { rmSync(directory, { recursive: true, force: true }); }
