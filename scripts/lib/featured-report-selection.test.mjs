import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTranslationSource } from './featured-report-selection.mjs';
import { checkCoverage } from './featured-report-files.mjs';
import { planTranslationBatches, translateReport } from './featured-report-batches.mjs';
const block = (id, original) => ({ id, original, sourceLocations: [{ page: 1, bbox: [0, 0, 1, 1] }] });
const input = () => ({ sections: [
  { id: 'research', title: 'Risk factors', blocks: [block('a', 'Revenue may fall 20% due to litigation and regulatory risks.')] },
  { id: 'legal', title: 'Important disclosures', blocks: [block('b', 'Distribution is restricted.'), block('c', 'Additional legal terms.')] },
  { id: 'valuation', title: 'Valuation', blocks: [block('d', 'Target price is $100.'), block('e', 'This report is for informational purposes only.')] },
] });
test('exclude complete boilerplate sections and paragraphs while preserving research and anchors', () => {
  const original = input(); const snapshot = structuredClone(original);
  const { source, skipped } = selectTranslationSource(original);
  assert.deepEqual(source.sections.flatMap(s => s.blocks.map(b => b.id)), ['a', 'd']);
  assert.deepEqual(skipped.map(b => b.id), ['b', 'c', 'e']);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(source.sections[0].blocks[0].sourceLocations, original.sections[0].blocks[0].sourceLocations);
});
test('coverage permits only identified omissions and still validates legacy full translations', () => {
  const original = input();
  const translate = source => ({ sections: source.sections.map(s => ({ ...s, blocks: s.blocks.map(b => ({ ...b, translation: '译文' })) })) });
  checkCoverage(translate(original), original);
  const selected = structuredClone(translate(selectTranslationSource(original).source));
  checkCoverage(selected, original);
  const lost = structuredClone(selected); lost.sections[0].blocks = [];
  assert.throws(() => checkCoverage(lost, original));
  const duplicate = structuredClone(selected); duplicate.sections[0].blocks.push(duplicate.sections[0].blocks[0]);
  assert.throws(() => checkCoverage(duplicate, original));
  selected.sections[0].blocks[0].sourceLocations[0].page = 2;
  assert.throws(() => checkCoverage(selected, original));
});
test('Chinese disclaimers are skipped but legal industry analysis and investment risks remain', () => {
  const source = { sections: [{ id: 's', title: '法律行业与风险提示', blocks: [
    block('a', '法律行业收入增长10%，投资者面临估值风险。'),
    block('b', '本报告不构成投资建议。'),
    block('c', '免责声明\n未经许可不得转载。'),
  ] }] };
  assert.deepEqual(selectTranslationSource(source).source.sections[0].blocks.map(b => b.id), ['a']);
});
test('excluded text never reaches whole translation or summary input', async () => {
  const { source } = selectTranslationSource(input());
  await translateReport(source, planTranslationBatches(source), async (kind, payload, check) => {
    assert.equal(kind, 'whole');
    assert.deepEqual(payload.blocks.map(b => b.id), ['a', 'd']);
    const result = { sections: source.sections.map(s => ({ id: s.id, title: s.title })), items: payload.blocks.map(b => ({ id: b.id, translation: '译文' })), summary: '总结', citations: ['a'] };
    check(result); return result;
  });
});
test('disclosure appendix spans pages while the research following it remains intact', () => {
  const source = { sections: [
    { id: 'body', title: 'Valuation', blocks: [block('value', 'Target price is based on 56x discounted P/E.'),
      block('footer', 'Goldman Sachs does and seeks to do business with companies covered in its research reports. Investors should be aware of a conflict of interest that could affect the objectivity of this report.')] },
    { id: 'appendix', title: 'Disclosure\nAppendix', blocks: [block('cert', 'We hereby certify our personal views.'),
      { ...block('continued', 'Banking Act 1959 continuation'), sourceLocations: [{ page: 5, bbox: [0, 0, 1, 1] }] }] },
    { id: 'risk', title: 'Risk factors', blocks: [block('risk', 'US export restrictions may delay customer capacity expansion.')] },
    { id: 'general', title: 'General disclosures', blocks: [block('terms', 'For our clients only.')] },
  ] };
  const selected = selectTranslationSource(source);
  assert.deepEqual(selected.source.sections.flatMap(s => s.blocks.map(b => b.id)), ['value', 'risk']);
  assert.deepEqual(selected.skipped.map(b => b.id), ['footer', 'cert', 'continued', 'terms']);
});
test('discussion of conflicts in industry research is not report boilerplate', () => {
  const source = { sections: [{ id: 's', title: 'Legal', blocks: [block('a', 'The regulator identified a conflict of interest at the company.')] }] };
  assert.equal(selectTranslationSource(source).skipped.length, 0);
});
