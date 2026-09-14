import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const python = process.env.PYTHON_BIN || 'python3';
const available = spawnSync(python, ['-c', 'import fitz']).status === 0;
test('two-column extraction respects a short spanning heading and preserves source rectangles', { skip: !available }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'featured-extract-'));
  try {
    const file = join(dir, 'source.pdf');
    execFileSync(python, ['-c', `import fitz, sys
d=fitz.open(); p=d.new_page(width=600,height=800)
p.insert_text((40,50),'1. Demand',fontsize=18)
p.insert_textbox(fitz.Rect(40,80,270,220),'Left column demand grew by 12%. '+('Customer demand. '*15),fontsize=11)
p.insert_textbox(fitz.Rect(325,80,570,220),'Right column risks include FX. '+('Renewal risks. '*15),fontsize=11)
p.insert_text((40,300),'2. Outlook',fontsize=18)
p.insert_textbox(fitz.Rect(40,330,570,500),'Outlook is conditional on renewals. '+('Outlook evidence. '*15),fontsize=11)
p=d.new_page(width=600,height=800)
p.insert_text((40,50),'3. Appendix',fontsize=18)
p.insert_textbox(fitz.Rect(40,80,570,300),'Appendix with further evidence. '*10,fontsize=11)
d.save(sys.argv[1])`, file]);
    const value = JSON.parse(execFileSync(python, [resolve('scripts/extract-featured-report.py'), file], { encoding: 'utf8' }));
    assert.equal(value.pageCount, 2);
    assert.deepEqual(value.sections.map(s => s.title), ['1. Demand', '2. Outlook', '3. Appendix']);
    const blocks = value.sections.flatMap(s => s.blocks);
    assert.ok(blocks.findIndex(b => b.original.startsWith('Right column')) < blocks.findIndex(b => b.original === '2. Outlook'));
    assert.ok(blocks.every(b => b.sourceLocations.every(l => l.bbox.every(v => v >= 0 && v <= 1))));
    assert.equal(new Set(blocks.map(b => b.id)).size, blocks.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
