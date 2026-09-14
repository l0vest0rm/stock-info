import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCoverage } from './featured-report-files.mjs';
test('review permits translation edits but never loses source anchors or entire paragraphs', () => {
  const source = { sections: [{ blocks: [{ id: 'a', original: 'source', sourceLocations: [{ page: 1, bbox: [0, 0, 1, 1] }] }] }] };
  const content = structuredClone(source); content.sections[0].blocks[0].translation = '人工修改';
  checkCoverage(content, source);
  content.sections[0].blocks[0].sourceLocations[0].page = 2;
  assert.throws(() => checkCoverage(content, source));
  assert.throws(() => checkCoverage({ sections: [] }, source));
});
