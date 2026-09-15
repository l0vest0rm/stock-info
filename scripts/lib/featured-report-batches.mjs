// Application budgets, not claims about the model's maximum context window.
// Reserve 4k of the existing 16k output allowance for headings, summary and variance.
export const OUTPUT_TOKENS = 16000;
export function estimateTranslationTokens(text) {
  const nonAscii = [...text].filter(c => c.codePointAt(0) > 127).length;
  return Math.ceil((text.length - nonAscii) * 0.65 + nonAscii * 1.5);
}
export function planTranslationBatches(source) {
  const batches = []; let batch = [], output = 0, input = 0;
  for (const section of source.sections) for (const block of section.blocks) {
    const item = { ...block, sectionId: section.id, sectionTitle: section.title };
    const out = estimateTranslationTokens(block.original) + 100 + estimateTranslationTokens(section.title);
    const incoming = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (out > 12000 || incoming > 24000) throw new Error(`${block.id} 超过单批预算，请拆分 source.json 中该段并保留来源位置`);
    if (batch.length && (output + out > 12000 || input + incoming > 24000)) {
      batches.push(batch); batch = []; output = 0; input = 0;
    }
    batch.push(item); output += out; input += incoming;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
export function validateBatchTranslation(result, blocks, requireDigest = true) {
  if (!Array.isArray(result.items) || result.items.length !== blocks.length || (requireDigest && (typeof result.digest !== 'string' || !result.digest.trim()))
    || result.items.some((b, j) => b.id !== blocks[j].id || typeof b.translation !== 'string' || !b.translation.trim())) {
    throw new Error('Translation coverage mismatch');
  }
}

export function validateReportSummary(value, blocks) {
  if (typeof value.summary !== 'string' || !value.summary.trim()) throw new Error('Summary is empty');
}

export async function translateReport(source, groups, llm) {
  if (groups.length === 1) {
    const result = await llm('whole', { blocks: modelBlocks(groups[0]) }, value => {
      validateBatchTranslation(value, groups[0], false);
      validateReportSummary(value, groups[0]);
    });
    return { results: [result], summary: result };
  }
  const glossary = await llm('glossary', source.sections.map(s => ({ title: s.title, sample: s.blocks[0].original.slice(0, 500) })), v => {
    if (!Array.isArray(v.terms)) throw new Error('Invalid glossary');
  });
  const results = [], digests = [];
  for (const [i, blocks] of groups.entries()) {
    const result = await llm('translate', { glossary,
      context: { previous: groups[i-1]?.at(-1)?.original || '', next: groups[i+1]?.[0]?.original || '' }, blocks: modelBlocks(blocks) }, v => validateBatchTranslation(v, blocks));
    results.push(result);
    digests.push({ digest: result.digest });
  }
  const summary = await llm('summary', digests, v => validateReportSummary(v, groups.flat()));
  return { results, summary };
}

// Geometry stays in the local extraction record; the model only returns text by ID.
function modelBlocks(blocks) {
  return blocks.map(({ id, original, sectionTitle }) => ({ id, original, sectionTitle }));
}
