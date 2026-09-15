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
