export type SourceLocation = { page: number; bbox: [number, number, number, number] };
export type TranslatedBlock = { id: string; translation: string; sourceLocations: SourceLocation[] };
export type FeaturedContent = {
  schemaVersion: 1;
  reportId: string;
  title: string;
  institution: string;
  reportDate: string;
  pageCount: number;
  summary: string;
  sections: { id: string; title: string; blocks: TranslatedBlock[] }[];
};
export const MAX_CONTENT_BYTES = 12 * 1024 * 1024;
export function validateContent(value: unknown): FeaturedContent {
  const c = value as FeaturedContent;
  const validText = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (!c || c.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(c.reportId) || !validText(c.title, 500)
    || typeof c.institution !== 'string' || c.institution.length > 500 || typeof c.reportDate !== 'string'
    || !/^$|^\d{4}-\d{2}-\d{2}$/.test(c.reportDate) || !Number.isInteger(c.pageCount) || c.pageCount < 1
    || !validText(c.summary, 100000) || !Array.isArray(c.sections) || !c.sections.length) throw new Error('Invalid report content');
  const ids = new Set<string>();
  for (const s of c.sections) {
    if (!validText(s.id, 100) || ids.has(s.id) || !validText(s.title, 500) || !Array.isArray(s.blocks) || !s.blocks.length) throw new Error('Invalid section');
    ids.add(s.id);
    for (const b of s.blocks) {
      if (!validText(b.id, 100) || ids.has(b.id) || !validText(b.translation, 100000) || !Array.isArray(b.sourceLocations) || !b.sourceLocations.length) throw new Error('Missing or duplicate translation block');
      ids.add(b.id);
      for (const l of b.sourceLocations) {
        if (!Number.isInteger(l.page) || l.page < 1 || l.page > c.pageCount || !Array.isArray(l.bbox) || l.bbox.length !== 4
          || l.bbox.some(n => !Number.isFinite(n) || n < 0 || n > 1) || l.bbox[0] >= l.bbox[2] || l.bbox[1] >= l.bbox[3]) throw new Error('Invalid PDF source location');
      }
    }
  }
  return c;
}
