import { existsSync, mkdtempSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash, readJson } from './featured-report-files.mjs';

const cleaner = '/Users/terry/git/skills/attachments-to-markdown/scripts/clean-pdf.py';

// original.pdf is the reading/publication PDF, so its coordinates and hash
// must describe the cleaned document used by extraction.
export function prepareCleanPdf(dir, bytes) {
  const output = join(dir, 'original.pdf');
  const audit = join(dir, 'original.pdf.json');
  if (existsSync(output)) {
    if (!existsSync(audit)) throw new Error('已有目录未经 PDF 清理，请使用新的 --out 目录重新生成');
    const record = readJson(audit);
    if (record.source_sha256 !== hash(bytes)) throw new Error('Output directory belongs to a different PDF');
    if (record.output_sha256 !== hash(readFileSync(output))) throw new Error('Cleaned PDF checksum mismatch');
    return output;
  }
  const staging = mkdtempSync(join(dir, '.clean-'));
  try {
    const input = join(staging, 'input.pdf');
    const cleaned = join(staging, 'cleaned.pdf');
    // URL and local inputs share a temporary input; never retain a raw copy.
    writeFileSync(input, bytes);
    execFileSync(process.env.PYTHON_BIN || 'python3', [cleaner, input, '--output', cleaned], {
      stdio: 'inherit', timeout: 600000,
    });
    const record = readJson(`${cleaned}.json`);
    record.output_sha256 = hash(readFileSync(cleaned));
    delete record.source; // The temporary input path will no longer exist.
    writeFileSync(`${cleaned}.json`, JSON.stringify(record, null, 2) + '\n');
    renameSync(`${cleaned}.json`, audit);
    renameSync(cleaned, output);
    return output;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
