import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { requestLocalDirectLlmText } from '../src/shared/local-direct-llm.ts';
import { validateContent } from '../src/modules/featured-reports/domain/content.ts';
import { root, hash, readJson, writeJson, loadCredentials, checkCoverage } from './lib/featured-report-files.mjs';
import { startReviewServer } from './lib/featured-report-review.mjs';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('Usage: ./prepare-featured-report.sh <PDF URL|path> [--out DIR] [--title TITLE] [--institution NAME] [--date YYYY-MM-DD]\n       ./prepare-featured-report.sh --review DIR [--port 8791]\n       ./prepare-featured-report.sh <PDF path> --extract-only');
  process.exit(0);
}
function option(flag, fallback = '') { const i = args.indexOf(flag); if (i < 0) return fallback; if (!args[i+1] || args[i+1].startsWith('--')) throw new Error(`Missing ${flag}`); return args[i+1]; }
if (args.includes('--review')) {
  await startReviewServer(resolve(option('--review')), Number(option('--port', '8791')));
} else {
  if (process.env.LLM_RUNTIME !== 'local') throw new Error('Use the supported local launcher');
  loadCredentials();
  const input = args[0];
  let bytes;
  if (/^https?:\/\//.test(input)) {
    // Persist URL downloads so rerunning a failed translation does not redownload.
    const cache = join(root, 'data/featured-reports/downloads'); mkdirSync(cache, { recursive: true });
    const cached = join(cache, `${hash(input)}.pdf`);
    if (existsSync(cached)) bytes = readFileSync(cached);
    else {
      const response = await fetch(input, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`PDF download HTTP ${response.status}`);
      const parts = []; let size = 0;
      for await (const part of response.body) { size += part.length; if (size > 200 * 1024 * 1024) throw new Error('PDF exceeds 200 MiB'); parts.push(part); }
      bytes = Buffer.concat(parts);
      if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('URL did not return a PDF');
      writeFileSync(`${cached}.${process.pid}.tmp`, bytes); renameSync(`${cached}.${process.pid}.tmp`, cached);
    }
  } else bytes = readFileSync(resolve(input));
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('Not a PDF file');
  const reportId = hash(bytes);
  const dir = resolve(option('--out', join(root, 'data/featured-reports', reportId)));
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, '.prepare.lock');
  if (existsSync(lock)) {
    const owner = Number(readFileSync(lock, 'utf8'));
    if (!Number.isInteger(owner) || owner < 1) throw new Error(`Invalid preparation lock: ${lock}`);
    try { process.kill(owner, 0); throw new Error(`Preparation is already running (PID ${owner})`); }
    catch (e) { if (e.code === 'ESRCH') unlinkSync(lock); else throw e; }
  }
  const fd = openSync(lock, 'wx'); writeFileSync(fd, String(process.pid));
  try {
    const original = join(dir, 'original.pdf');
    if (existsSync(original) && hash(readFileSync(original)) !== reportId) throw new Error('Output directory belongs to a different PDF');
    writeFileSync(original, bytes);
    const sourceFile = join(dir, 'source.json');
    if (!existsSync(sourceFile)) {
      const source = JSON.parse(execFileSync(process.env.PYTHON_BIN || 'python3', [join(root, 'scripts/extract-featured-report.py'), original], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000 }));
      writeJson(sourceFile, source);
    }
    const source = readJson(sourceFile);
    writeJson(join(dir, 'manifest.json'), { reportId, source: input, model: 'gpt-5.6-luna', pageCount: source.pageCount });
    if (args.includes('--extract-only')) console.log(`提取完成：${sourceFile}`);
    else if (existsSync(join(dir, 'content.json'))) {
      console.log('保留已有译文和人工修改。使用 --review 审阅；重新生成请使用新的 --out 目录。');
    } else {
      const cache = join(dir, 'cache'); mkdirSync(cache, { recursive: true });
      const llm = async (kind, input, check) => {
        const prompt = readFileSync(join(root, `prompts/featured-report-${kind}.md`), 'utf8');
        const key = hash(JSON.stringify({ model: 'gpt-5.6-luna', prompt, input }));
        const file = join(cache, `${key}.json`);
        if (existsSync(file)) { const result = readJson(file); check(result); return result; }
        let last;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await requestLocalDirectLlmText(process.env, { model: 'gpt-5.6-luna', instructions: prompt,
              input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(input) }] }], maxTokens: kind === 'translate' ? 16000 : 10000,
              signal: AbortSignal.timeout(240000) });
            const data = JSON.parse(response.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
            check(data); writeJson(file, data); return data;
          } catch (e) { last = e; console.error(`${kind} 第 ${attempt+1} 次失败：${e.message}`); }
        }
        throw last;
      };
      const glossary = await llm('glossary', source.sections.map(s => ({ title: s.title, sample: s.blocks[0].original.slice(0, 500) })), v => { if (!Array.isArray(v.terms)) throw new Error('Invalid glossary'); });
      const digests = [], sections = [], checks = [...source.issues];
      for (const section of source.sections) {
        const groups = []; let group = [], length = 0;
        for (const block of section.blocks) {
          if (block.original.length > 20000) throw new Error(`${block.id} 超过单段限制，请先拆分 source.json 中该段并保留来源位置`);
          if (length + block.original.length > 6500 && group.length) { groups.push(group); group = []; length = 0; }
          group.push(block); length += block.original.length;
        }
        if (group.length) groups.push(group);
        const translated = []; let translatedTitle = section.title;
        for (const [i, blocks] of groups.entries()) {
          console.log(`翻译 ${section.title} ${i+1}/${groups.length}`);
          const result = await llm('translate', { glossary, section: section.title,
            context: { previous: groups[i-1]?.at(-1)?.original || '', next: groups[i+1]?.[0]?.original || '' }, blocks }, v => {
            if (!Array.isArray(v.items) || v.items.length !== blocks.length || !v.digest || typeof v.sectionTitle !== 'string' || !v.sectionTitle.trim()
              || v.items.some((b, j) => b.id !== blocks[j].id || typeof b.translation !== 'string' || !b.translation.trim())) throw new Error('Translation coverage mismatch');
          });
          if (i === 0) translatedTitle = result.sectionTitle;
          digests.push({ digest: result.digest, sources: blocks.map(b => ({ id: b.id, pages: b.sourceLocations.map(l => l.page) })) });
          result.items.forEach((b, j) => {
            const original = blocks[j];
            const numbers = original.original.match(/\d+(?:[,.]\d+)*(?:%|％)?/g) || [];
            const missing = numbers.filter(n => !b.translation.replaceAll(',', '').includes(n.replaceAll(',', '')));
            if (missing.length) checks.push(`${b.id}：请核对数字 ${[...new Set(missing)].join('、')}`);
            if (b.translation.includes('[原文不清]')) checks.push(`${b.id}：原文不清，需要人工核对`);
            translated.push({ id: b.id, translation: b.translation, sourceLocations: original.sourceLocations });
          });
        }
        sections.push({ id: section.id, title: translatedTitle, blocks: translated });
      }
      const ids = new Set(source.sections.flatMap(s => s.blocks.map(b => b.id)));
      const summary = await llm('summary', digests, v => {
        if (typeof v.summary !== 'string' || !v.summary.trim() || !Array.isArray(v.citations) || !v.citations.length || v.citations.some(id => !ids.has(id))) throw new Error('Summary lacks valid source citations');
      });
      const content = validateContent({ schemaVersion: 1, reportId, title: option('--title', source.title || basename(input).replace(/\.pdf$/i, '')),
        institution: option('--institution'), reportDate: option('--date'), pageCount: source.pageCount, summary: summary.summary, sections });
      checkCoverage(content, source);
      writeJson(join(dir, 'content.json'), content);
      writeJson(join(dir, 'checks.json'), { issues: checks, summaryCitations: summary.citations });
      writeJson(join(dir, 'review.json'), { approvedHash: null });
    }
    console.log(`本地目录：${dir}\n审阅命令：./prepare-featured-report.sh --review '${dir.replaceAll("'", "'\\''")}'`);
  } finally { closeSync(fd); unlinkSync(lock); }
}
