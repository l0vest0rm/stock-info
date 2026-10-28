#!/usr/bin/env node
/**
 * Validate the daily review notes under `docs/investment-daily/`.
 *
 * This checks *structure*, not analytical quality — that needs a human.  But the
 * structural failures it catches are the ones that make the archive worthless:
 *
 * - a template left unfilled (a `YYYY-MM-DD` file that is really TEMPLATE.md);
 * - a note with no date in its name, or a date that disagrees with its content,
 *   which breaks the one-file-per-day rule the backtest depends on;
 * - a note whose sections were deleted, so "not done" becomes indistinguishable
 *   from "no change";
 * - private portfolio data (holdings, cost basis, account balance) or a buy/sell
 *   instruction, which must never enter this repository;
 * - an unexplained `unattributed` band change, which is the one attribution a
 *   reader cannot act on.
 *
 * Usage:
 *   node scripts/check-daily-notes.mjs           # validate every note
 *   node scripts/check-daily-notes.mjs --json
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const notesDir = resolve(root, 'docs/investment-daily');
const args = new Set(process.argv.slice(2));

const REQUIRED_SECTIONS = [
  '## 1. 本次概况',
  '## 2. 估值区间变化',
  '## 3. 新增的关键事实（只报增量）',
  '## 4. 研究动作',
  '## 5. 被否掉的假设',
  '## 6. 覆盖缺口',
  '## 7. 与上一日的差异',
  '## 8. 自检',
];

/**
 * Private-portfolio vocabulary.  These are the exact things that must not end up
 * in a shared note: a holding size, a cost basis, an account balance, or a direct
 * instruction.  Research language ("估值进入区间", "候选") is deliberately allowed.
 */
const FORBIDDEN = [
  { pattern: /我的持仓|当前持仓(?!复核)|持仓数量|持仓成本|成本价|买入成本/, label: 'personal holdings or cost basis' },
  { pattern: /账户余额|可用资金|总资产|仓位占比\s*\d+%/ , label: 'account balance or position sizing' },
  { pattern: /立即买入|立即卖出|建议买入|建议卖出|目标价\s*[:：]?\s*\d/, label: 'trade instruction or price target' },
];

const PLACEHOLDERS = [/YYYY-MM-DD/, /\|\s*\|\s*\|\s*\|/, /N\s*\/\s*98/, /本次未覆盖/];

function validateNote(file, text) {
  const problems = [];
  const nameMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  if (!nameMatch) {
    problems.push('file name must be YYYY-MM-DD.md');
    return problems;
  }
  const fileDate = nameMatch[1];
  if (Number.isNaN(Date.parse(`${fileDate}T00:00:00Z`))) {
    problems.push(`invalid date in file name: ${fileDate}`);
  }

  for (const section of REQUIRED_SECTIONS) {
    if (!text.includes(section)) problems.push(`missing section: ${section}`);
  }

  for (const { pattern, label } of FORBIDDEN) {
    if (pattern.test(text)) problems.push(`contains ${label}, which must stay out of this repository`);
  }

  // A note that still reads like the template is not a record of a day.
  for (const placeholder of PLACEHOLDERS) {
    if (placeholder.test(text)) problems.push(`template placeholder left in note: ${placeholder}`);
  }

  // The report date in the body must match the file name, or the archive has two
  // disagreeing dates and no way to pick one.
  const declared = text.match(/\|\s*报告日\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/);
  if (!declared) {
    problems.push('section 1 must declare a 报告日 row with a YYYY-MM-DD value');
  } else if (declared[1] !== fileDate) {
    problems.push(`报告日 ${declared[1]} disagrees with file name ${fileDate}`);
  }

  // Attribution: every change row must carry one of the four known labels, and
  // `unattributed` must be explained rather than left bare.
  const attributionSection = text.split('## 2. 估值区间变化')[1]?.split('## 3.')[0] ?? '';
  const rows = attributionSection.split('\n').filter((line) => line.trim().startsWith('|') && !/^\|\s*-+/.test(line.trim()));
  const dataRows = rows.filter((line) => !/公司\s*\|/.test(line));
  for (const row of dataRows) {
    const cells = row.split('|').map((cell) => cell.trim()).filter(Boolean);
    // A row saying "nothing changed" is a placeholder, not a change record: the
    // company cell is 无/（无）, or every cell is a dash.  It has nothing to attribute.
    const isPlaceholderRow = cells.every((cell) => ['—', '-', '（无）', '无'].includes(cell))
      || ['（无）', '无', '—'].includes(cells[0]);
    if (isPlaceholderRow) continue;
    const hasAttribution = cells.some((cell) => ['filing', 'model', 'price_source', 'unattributed'].includes(cell));
    if (cells.length >= 3 && !hasAttribution) {
      problems.push(`band change row lacks attribution: ${row.trim().slice(0, 80)}`);
    }
    if (cells.includes('unattributed')) {
      const explanation = cells.at(-1) ?? '';
      if (explanation.length < 8) {
        problems.push(`unattributed change must explain why: ${row.trim().slice(0, 80)}`);
      }
    }
  }

  // Section 7 exists because silently reversing a previous conclusion is the most
  // damaging thing a research log can do.
  const diffSection = text.split('## 7. 与上一日的差异')[1]?.split('## 8.')[0] ?? '';
  if (!/与上一日结论相反|无相反/.test(diffSection)) {
    problems.push('section 7 must state whether any conclusion was reversed (write 无相反 if none)');
  }

  return problems;
}

if (!existsSync(notesDir)) {
  console.log('Daily notes: 0 notes (docs/investment-daily does not exist yet)');
  process.exit(0);
}

const files = readdirSync(notesDir)
  .filter((name) => name.endsWith('.md') && name !== 'README.md' && name !== 'TEMPLATE.md')
  .sort();

const failures = [];
for (const file of files) {
  const text = readFileSync(resolve(notesDir, file), 'utf8');
  const problems = validateNote(file, text);
  if (problems.length) failures.push({ file, problems });
}

// Duplicate dates cannot happen with one file per date, but a copy named
// `2026-10-28-copy.md` would slip past the pattern check as an extra note.
const dates = files.map((name) => name.slice(0, 10));
const duplicates = dates.filter((date, index) => dates.indexOf(date) !== index);
for (const date of new Set(duplicates)) failures.push({ file: date, problems: ['two notes for the same date'] });

if (args.has('--json')) {
  console.log(JSON.stringify({ notes: files.length, failures }, null, 2));
} else if (failures.length === 0) {
  console.log(`Daily notes valid: ${files.length} note(s)${files.length ? ` (${files[0]} … ${files.at(-1)})` : ''}`);
} else {
  for (const failure of failures) {
    console.error(`FAIL ${failure.file}`);
    for (const problem of failure.problems) console.error(`  - ${problem}`);
  }
}

if (failures.length) process.exit(1);
assert.ok(true);
