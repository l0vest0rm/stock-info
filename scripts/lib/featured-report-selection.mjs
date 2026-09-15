// Only explicit boilerplate headings select a whole section. Generic headings such
// as “Risk factors”, “Legal” or “Disclosures” can contain substantive research.
const heading = /^(?:(?:important|general|legal|regulatory)\s+)?(?:disclosure appendi(?:x|ces)|general disclosures?|disclaimers?|legal notices?|legal disclosures?|regulatory disclosures?|important disclosures?|analyst certifications?|analyst disclosures?|conflicts? of interest|distribution restrictions?|copyright(?: notice)?|免责声明|法律声明|重要声明|重要披露|分析师声明|分析师承诺|分析师认证|利益冲突披露|分发限制|版权声明)(?:\s*(?:and|&)\s*(?:disclaimers?|disclosures?|analyst certifications?))*[\s:：.。]*$/i;
function isHeading(text) {
  return heading.test(String(text || '').trim().replace(/\s+/g, ' '));
}
function boilerplateParagraph(text) {
  // Require a report/distribution subject plus a specific legal formula; a
  // discussion of regulation, litigation or investment risk alone never matches.
  const normalized = String(text || '').replace(/\s+/g, ' ');
  if (/\bconflict of interest\b/i.test(normalized)
    && /\bobjectivity of this (?:report|research)\b/i.test(normalized)
    && /\bdoes and seeks to do business\b/i.test(normalized)) return true;
  return /(?:\bthis (?:report|material|document|publication)\b|本(?:报告|材料|文件))/i.test(normalized)
    && /(?:does not constitute (?:investment advice|an offer|a solicitation)|not (?:intended for|for) distribution|may not be (?:reproduced|redistributed)|for informational purposes only|不构成.{0,12}(?:投资建议|要约)|未经.{0,30}(?:不得|禁止).{0,12}(?:复制|转载|传播))/i.test(normalized);
}
export function selectTranslationSource(source) {
  const skipped = [];
  const sections = source.sections.map(section => {
    const sectionIsBoilerplate = isHeading(section.title);
    const blocks = section.blocks.filter(block => {
      const reason = sectionIsBoilerplate ? '法律、声明等固定章节' :
        (isHeading(block.original.split('\n')[0]) || boilerplateParagraph(block.original)) ? '法律、声明等固定段落' : null;
      if (reason) skipped.push({ id: block.id, sectionId: section.id, reason, sourceLocations: block.sourceLocations });
      return !reason;
    });
    return { ...section, blocks };
  }).filter(section => section.blocks.length);
  return { source: { ...source, sections }, skipped };
}

function omissionLabel(block, section) {
  const text = block.original;
  if (/copyright|©|版权|You are permitted to store/i.test(text)) return '版权及使用限制';
  if (/conflict[s]? of interest|利益冲突/i.test(text)) return '利益冲突披露';
  if (/Reg AC|hereby certify|analyst certification|分析师声明|分析师认证/i.test(text)) return '分析师声明';
  if (/regulatory disclosures|laws and regulations|法律声明|法律条文/i.test(text)) return '法律及监管披露';
  if (/disclaimer|免责声明|does not constitute|not an offer to sell/i.test(text)) return '免责声明';
  if (/disclosure appendi(?:x|ces)/i.test(section.title)) return '披露附录（含评级说明等附属信息）';
  return '法律声明及固定披露信息';
}

// Selection happens before model calls. Placeholders are deterministic local text,
// inserted only when assembling the reader artifact, at the original block anchors.
export function addOmissionPlaceholders(source, translatedSections) {
  const skipped = new Set(selectTranslationSource(source).skipped.map(b => b.id));
  const translated = new Map(translatedSections.flatMap(s => s.blocks).map(b => [b.id, b]));
  const titles = new Map(translatedSections.map(s => [s.id, s.title]));
  return source.sections.map(section => ({
    id: section.id,
    title: titles.get(section.id) || section.title,
    blocks: section.blocks.map(block => {
      if (skipped.has(block.id)) return {
        id: block.id,
        translation: `> 【未翻译：${omissionLabel(block, section)}】此处为非研究正文的附属信息，无需逐段翻译；请参阅对应位置的原文。`,
        sourceLocations: block.sourceLocations,
      };
      const result = translated.get(block.id);
      if (!result) throw new Error(`研究正文译文缺失: ${block.id}`);
      return result;
    }),
  }));
}
