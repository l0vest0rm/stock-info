import {
  fetchStatutoryDisclosureIndex,
  type StatutoryDisclosureIndex,
  type StatutoryDisclosureIndexOptions,
} from "../../../adapters/statutory-disclosures";

export async function refreshResearchStatutoryDisclosureIndex(
  db: D1Database,
  securityCode: string,
  options: StatutoryDisclosureIndexOptions = {},
): Promise<StatutoryDisclosureIndex> {
  const index = await fetchStatutoryDisclosureIndex(db, securityCode, options);
  if (index.availability !== "available") return index;
  const indexedAt = Date.now();
  await db.batch(index.documents.map((document) => db.prepare(`insert or ignore into research_statutory_disclosure_documents (
    registry, security_code, document_id, title, published_at, document_url, document_type, source_locator, indexed_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(document.registry, document.securityCode, document.documentId, document.title, document.publishedAt, document.documentUrl, document.documentType, document.sourceLocator, indexedAt)));
  return index;
}

export async function loadResearchStatutoryDisclosureDocuments(db: D1Database, securityCode: string): Promise<{ availability: "available" | "empty" | "unavailable"; reason: string | null; items: Array<Record<string, unknown>> }> {
  try {
    const rows = await db.prepare(`select registry, security_code as securityCode, document_id as documentId, title, published_at as publishedAt, document_url as documentUrl, document_type as documentType, source_locator as sourceLocator, indexed_at as indexedAt from research_statutory_disclosure_documents where security_code=? order by published_at desc, indexed_at desc limit 200`).bind(securityCode).all();
    return { availability: rows.results.length ? "available" : "empty", reason: rows.results.length ? null : "no_records", items: rows.results as Array<Record<string, unknown>> };
  } catch (error) {
    if (/no such table|does not exist|not found/i.test(error instanceof Error ? error.message : String(error))) return { availability: "unavailable", reason: "storage_not_initialized", items: [] };
    throw error;
  }
}
