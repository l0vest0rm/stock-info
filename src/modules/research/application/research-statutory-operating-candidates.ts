import {
  materializeResearchInformationEvidenceCandidates,
  type ResearchInformationEvidenceSourceRecord,
} from "./research-information-evidence";

type Row = Record<string, unknown>;

export type StatutoryOperatingCandidateDocument = {
  registry: "cninfo" | "hkex" | "sec";
  documentId: string;
  documentUrl: string;
  sourceLocator: string;
};

export type StatutoryOperatingCandidateProduction = {
  securityCode: string;
  indexedDocumentCount: number;
  processedInformationRecordCount: number;
  created: number;
  existing: number;
  provenanceCreated: number;
  rejectionReasons: string[];
  /** Every candidate is still a review candidate: this producer writes no fact, model, scenario, or valuation. */
  limitations: string[];
};

type StatutoryInformationRecord = ResearchInformationEvidenceSourceRecord & StatutoryOperatingCandidateDocument;

/**
 * Materializes operating evidence candidates only when an already-processed
 * information record can be joined to an indexed public statutory document by
 * its exact immutable document URL.  It does not fetch or parse the document,
 * call an LLM itself, accept a candidate, or create a typed analysis record.
 */
export async function produceResearchStatutoryOperatingEvidenceCandidates(
  db: D1Database,
  securityCode: string,
  createdAt = Date.now(),
): Promise<StatutoryOperatingCandidateProduction> {
  const code = required(securityCode, "securityCode").toUpperCase();
  const indexed = await db.prepare(`select registry, document_id as documentId, document_url as documentUrl, source_locator as sourceLocator
    from research_statutory_disclosure_documents where security_code=? order by published_at desc, indexed_at desc, document_id desc limit 200`)
    .bind(code).all<Row>();
  const statutoryDocuments = indexed.results.map(document);
  if (!statutoryDocuments.length) return result(code, 0, 0, 0, 0, 0, ["statutory_documents_not_indexed"]);

  // Exact URL equality is intentional.  A similarly titled news item, report,
  // CDN mirror, or analyst transcription cannot inherit statutory authority.
  const sourceRows = await db.prepare(`select record.information_id as informationId, record.entity, record.information_type as informationType,
      record.category, record.period, record.statement, result.result_id as resultId, result.run_id as runId,
      version.version_id as versionId, version.content_hash as contentHash, version.doc_id as docId,
      coalesce(version.source_url, doc.url) as sourceUrl, content.content_url as contentUrl, doc.title,
      doc.source_name as sourceName, coalesce(version.published_at, doc.published_at) as publishedAt,
      statutory.registry, statutory.document_id as documentId, statutory.document_url as documentUrl, statutory.source_locator as sourceLocator
    from research_statutory_disclosure_documents statutory
    join knowledge_docs doc on doc.url=statutory.document_url
    join knowledge_document_versions version on version.doc_id=doc.doc_id and coalesce(version.source_url, doc.url)=statutory.document_url
    join knowledge_document_results result on result.version_id=version.version_id and result.outcome='extracted'
    join knowledge_information_records record on record.result_id=result.result_id
    join knowledge_company_code_mappings mapping on mapping.company_name=record.entity and mapping.code=statutory.security_code
    left join knowledge_doc_content_refs content on content.doc_id=doc.doc_id
    where statutory.security_code=?
    order by result.created_at desc, record.sort_order asc, record.information_id asc`)
    .bind(code).all<Row>();
  const sourceRecords = sourceRows.results.map(statutorilyBoundRecord);
  const materialized = await materializeResearchInformationEvidenceCandidates(
    db,
    code,
    sourceRecords,
    createdAt,
    { includePersistedIds: true },
  );
  let provenanceCreated = 0;
  for (const item of materialized.candidates) {
    const origin = sourceRecords.find((record) => record.informationId === item.source.informationId
      && record.resultId === item.source.resultId && record.versionId === item.source.versionId && record.documentUrl === item.source.sourceUrl);
    if (!origin) throw new Error("statutory candidate provenance could not be resolved from immutable source row");
    const inserted = await db.prepare(`insert into research_statutory_operating_candidate_provenance (
      candidate_id, registry, security_code, statutory_document_id, statutory_document_url, statutory_source_locator,
      knowledge_doc_id, result_id, run_id, version_id, content_hash, producer_version, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'research-statutory-operating-candidates.v1', ?)
    on conflict(candidate_id) do nothing`)
      .bind(item.candidateId, origin.registry, code, origin.documentId, origin.documentUrl, origin.sourceLocator,
        origin.docId, origin.resultId, origin.runId, origin.versionId, origin.contentHash, createdAt).run();
    provenanceCreated += Number(inserted.meta.changes ?? 0);
  }
  const rejectionReasons = sourceRecords.length === 0
    ? ["no_exact_statutory_information_processing_record"]
    : materialized.candidates.length === 0 ? ["no_configured_operating_mapping_for_statutory_records"] : [];
  return result(code, statutoryDocuments.length, sourceRecords.length, materialized.created, materialized.existing, provenanceCreated, rejectionReasons);
}

function result(
  securityCode: string,
  indexedDocumentCount: number,
  processedInformationRecordCount: number,
  created: number,
  existing: number,
  provenanceCreated: number,
  rejectionReasons: string[],
): StatutoryOperatingCandidateProduction {
  return {
    securityCode, indexedDocumentCount, processedInformationRecordCount, created, existing, provenanceCreated, rejectionReasons,
    limitations: [
      "仅复用已完成的信息预处理记录及其 document/result/run/version/content_hash 链；不会重新解析原文或绕过本地 LLM 边界。",
      "只生成待审核候选和法定披露来源绑定；不会接受证据、不会写入经营模型、驱动计划、情景、市场空间或估值。",
      "仅接受索引法定披露 URL 与信息处理版本 URL 的精确匹配；缺少导入、处理、精确公司映射或配置字段时会保留拒绝原因。",
    ],
  };
}

function statutorilyBoundRecord(row: Row): StatutoryInformationRecord {
  const sourceUrl = optional(row.sourceUrl);
  const documentUrl = required(row.documentUrl, "stored statutory documentUrl");
  if (sourceUrl !== documentUrl) throw new Error("statutory information source URL must exactly match indexed document URL");
  return {
    informationId: required(row.informationId, "stored informationId"), entity: required(row.entity, "stored entity"),
    informationType: required(row.informationType, "stored informationType"), category: required(row.category, "stored category"),
    period: optional(row.period), statement: required(row.statement, "stored statement"), resultId: required(row.resultId, "stored resultId"),
    runId: required(row.runId, "stored runId"), versionId: required(row.versionId, "stored versionId"), contentHash: required(row.contentHash, "stored contentHash"),
    docId: required(row.docId, "stored docId"), sourceUrl, contentUrl: optional(row.contentUrl), title: optional(row.title),
    sourceName: optional(row.sourceName), publishedAt: optional(row.publishedAt), ...document(row),
  };
}

function document(row: Row): StatutoryOperatingCandidateDocument {
  const registry = required(row.registry, "stored statutory registry");
  if (!(registry === "cninfo" || registry === "hkex" || registry === "sec")) throw new Error("stored statutory registry is invalid");
  return { registry, documentId: required(row.documentId, "stored statutory documentId"), documentUrl: required(row.documentUrl, "stored statutory documentUrl"), sourceLocator: required(row.sourceLocator, "stored statutory sourceLocator") };
}
function required(value: unknown, label: string): string { const text = String(value ?? "").trim(); if (!text) throw new Error(`${label} is required`); return text; }
function optional(value: unknown): string | null { const text = String(value ?? "").trim(); return text || null; }
