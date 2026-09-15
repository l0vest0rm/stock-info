import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { requestLocalDirectLlmText } from '../src/shared/local-direct-llm.ts';
import { validateContent } from '../src/modules/featured-reports/domain/content.ts';
import { root, hash, readJson, writeJson, loadCredentials, checkCoverage } from './lib/featured-report-files.mjs';
import { registerLocalReport } from './lib/featured-report-local.mjs';
import { startReviewServer } from './lib/featured-report-review.mjs';

import { selectTranslationSource, addOmissionPlaceholders } from './lib/featured-report-selection.mjs';
import { planTranslationBatches, translateReport, OUTPUT_TOKENS, validateReportSummary } from './lib/featured-report-batches.mjs';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('Usage: ./prepare-featured-report.sh <PDF URL|path> [--out DIR] [--title TITLE] [--institution NAME] [--date YYYY-MM-DD] [--refilter]\n       ./prepare-featured-report.sh --review DIR [--port 8791]\n       ./prepare-featured-report.sh <PDF path> --extract-only');
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
    if (!existsSync(join(dir, 'manifest.json'))) writeJson(join(dir, 'manifest.json'), { reportId, source: input, model: 'gpt-5.6-luna', pageCount: source.pageCount });
    if (args.includes('--extract-only')) console.log(`提取完成：${sourceFile}`);
    else if (existsSync(join(dir, 'content.json')) && !args.includes('--refilter')) {
      console.log('保留已有译文和人工修改；应用最新声明过滤并更新摘要请加 --refilter，全部重新生成请使用新的 --out 目录。');
    } else {
      const cache = join(dir, 'cache'); mkdirSync(cache, { recursive: true });
      const llm = async (kind, input, check) => {
        console.log(`模型步骤：${kind}`);
        const prompt = readFileSync(join(root, `prompts/featured-report-${kind}.md`), 'utf8');
        const key = hash(JSON.stringify({ model: 'gpt-5.6-luna', prompt, input }));
        const file = join(cache, `${key}.json`);
        if (existsSync(file)) { const result = readJson(file); check(result); return result; }
        let last;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await requestLocalDirectLlmText(process.env, { model: 'gpt-5.6-luna', instructions: prompt,
              input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(input) }] }], maxTokens: ['translate', 'whole'].includes(kind) ? OUTPUT_TOKENS : 10000,
              signal: AbortSignal.timeout(240000) });
            const data = JSON.parse(response.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
            check(data); writeJson(file, data); return data;
          } catch (e) { last = e; console.error(`${kind} 第 ${attempt+1} 次失败：${e.message}`); }
        }
        throw last;
      };
      const { source: translationSource, skipped } = selectTranslationSource(source);
      if (!translationSource.sections.length) throw new Error('排除固定声明后没有可翻译的研究正文');
      if (args.includes('--refilter') && existsSync(join(dir, 'content.json'))) {
        const contentFile = join(dir, 'content.json');
        const previous = readJson(contentFile);
        checkCoverage(previous, source);
        const excluded = new Set(skipped.map(b => b.id));
        const sections = previous.sections.map(s => ({ ...s, blocks: s.blocks.filter(b => !excluded.has(b.id)) })).filter(s => s.blocks.length);
        const summary = await llm('summary', translationSource.sections.map(s => ({
          title: s.title, digest: s.blocks.map(b => b.original).join('\n\n'),
        })), validateReportSummary);
        const content = validateContent({ ...previous, sections: addOmissionPlaceholders(source, sections), summary: summary.summary });
        checkCoverage(content, source);
        const checksFile = join(dir, 'checks.json');
        const checks = existsSync(checksFile) ? readJson(checksFile) : { issues: source.issues || [] };
        const backup = join(dir, `before-refilter-${hash(readFileSync(contentFile)).slice(0, 12)}`);
        mkdirSync(backup, { recursive: true });
        if (!existsSync(join(backup, 'content.json'))) writeFileSync(join(backup, 'content.json'), readFileSync(contentFile));
        if (existsSync(checksFile) && !existsSync(join(backup, 'checks.json'))) writeFileSync(join(backup, 'checks.json'), readFileSync(checksFile));
        writeJson(contentFile, content);
        writeJson(checksFile, { ...checks,
          issues: [...checks.issues.filter(issue => !skipped.some(b => issue.startsWith(`${b.id}：`) || issue.startsWith(`${b.id}（`))),
            ...skipped.map(b => `${b.id}（原文第 ${b.sourceLocations.map(l => l.page).join('、')} 页）：已跳过${b.reason}，请核对`)],
          skippedBlocks: skipped });
        console.log(`已重新过滤 ${skipped.length} 个声明段落并更新摘要；正文译文保留，原产物备份：${backup}`);
      } else {
        const groups = planTranslationBatches(translationSource);
        console.log(`全文 ${source.sections.length} 个章节，${groups.length} 批翻译，计划 ${groups.length === 1 ? 1 : groups.length + 2} 次模型调用`);
        const { results, summary } = await translateReport(translationSource, groups, llm);
        const sections = translationSource.sections.map(s => ({ id: s.id, title: s.title, blocks: [] })), checks = [...source.issues, ...skipped.map(b => `${b.id}（原文第 ${b.sourceLocations.map(l => l.page).join("、")} 页）：已跳过${b.reason}，请核对`)];
        const byId = new Map(sections.map(s => [s.id, s]));
        for (const [i, blocks] of groups.entries()) {
          const result = results[i];
          result.items.forEach((b, j) => {
            const original = blocks[j];
            const numbers = original.original.match(/\d+(?:[,.]\d+)*(?:%|％)?/g) || [];
            const missing = numbers.filter(n => !b.translation.replaceAll(',', '').includes(n.replaceAll(',', '')));
            if (missing.length) checks.push(`${b.id}：请核对数字 ${[...new Set(missing)].join('、')}`);
            if (b.translation.includes('[原文不清]')) checks.push(`${b.id}：原文不清，需要人工核对`);
            byId.get(original.sectionId).blocks.push({ id: b.id, translation: b.translation, sourceLocations: original.sourceLocations });
          });
        }
        const content = validateContent({ schemaVersion: 1, reportId, title: option('--title', source.title || basename(input).replace(/\.pdf$/i, '')),
          institution: option('--institution'), reportDate: option('--date'), pageCount: source.pageCount, summary: summary.summary, sections: addOmissionPlaceholders(source, sections) });
        checkCoverage(content, source);
        writeJson(join(dir, 'content.json'), content);
        writeJson(join(dir, 'checks.json'), { issues: checks, skippedBlocks: skipped });
      }
    }
    if (!args.includes('--extract-only')) {
      const { code } = registerLocalReport(dir);
      console.log(`本地研报码：${code}（仅本地查看，正式发布编号以发布结果为准）\n本地查看：http://127.0.0.1:${process.env.PORT || '8000'}/featured-report.html?code=${code}`);
    }
    console.log(`本地目录：${dir}\n审阅命令：./prepare-featured-report.sh --review '${dir.replaceAll("'", "'\\''")}'`);
  } finally { closeSync(fd); unlinkSync(lock); }
}
