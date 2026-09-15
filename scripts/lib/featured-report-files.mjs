import { selectTranslationSource } from './featured-report-selection.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
export const root = process.env.FEATURED_PROJECT_ROOT || resolve(new URL('../..', import.meta.url).pathname);
export const hash = value => createHash('sha256').update(value).digest('hex');
export const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
export function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  renameSync(temp, file);
}
export function loadCredentials() {
  const file = resolve(root, '.dev.vars');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z][A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value;
    try { value = JSON.parse(match[2]); } catch { value = match[2].replace(/^['"]|['"]$/g, ''); }
    process.env[match[1]] = String(value);
  }
}
export function checkCoverage(content, source) {
  const before = source.sections.flatMap(s => s.blocks);
  const after = content.sections.flatMap(s => s.blocks);
  const optional = new Set(selectTranslationSource(source).skipped.map(b => b.id));
  const sourceIds = new Set(before.map(b => b.id));
  if (new Set(after.map(b => b.id)).size !== after.length || after.some(b => !sourceIds.has(b.id))) throw new Error('译文段落 ID 重复或不属于原文');
  const map = new Map(after.map(b => [b.id, b]));
  for (const b of before) {
    const translated = map.get(b.id);
    if (!translated && optional.has(b.id)) continue;
    if (!translated?.translation?.trim() || JSON.stringify(translated.sourceLocations) !== JSON.stringify(b.sourceLocations)) throw new Error(`段落缺失或原文位置被修改: ${b.id}`);
  }
}
