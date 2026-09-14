#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const names = ['MAIL_SMTP_HOST', 'MAIL_SMTP_PORT', 'MAIL_SMTP_USERNAME', 'MAIL_SMTP_PASSWORD', 'MAIL_FROM_EMAIL'];
const local = {};
try {
  for (const line of readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split('\n')) {
    const match = line.match(/^([A-Z][A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    try { local[match[1]] = JSON.parse(match[2]); }
    catch { local[match[1]] = match[2].replace(/^['"]|['"]$/g, ''); }
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const secrets = Object.fromEntries(names.map((name) => [name, process.env[name] || local[name]]));
secrets.MAIL_FROM_NAME = 'TINFO.CC';
const missing = names.filter((name) => !secrets[name]);
if (missing.length) throw new Error(`Missing local mail settings: ${missing.join(', ')}`);
if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is required');
// Pipe values directly to Wrangler: no credential arguments, files or logs.
execFileSync('npx', ['wrangler', 'secret', 'bulk', '--name', process.env.CF_WORKER_NAME || 'stock-info'], {
  cwd: root, input: JSON.stringify(secrets), stdio: ['pipe', 'pipe', 'pipe'],
});
console.log('SMTP Worker secrets synced; sender TINFO.CC.');
