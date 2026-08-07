import type { Bindings } from "../../../types";

type Row = Record<string, unknown>;

type IndexedStatutoryDisclosure = {
  registry: "cninfo" | "hkex" | "sec";
  securityCode: string;
  documentId: string;
  title: string;
  publishedAt: string;
  documentUrl: string;
  documentType: string | null;
  sourceLocator: string;
  indexedAt: number;
};

export type ImportIndexedStatutoryDisclosureResult = {
  securityCode: string;
  registry: "cninfo" | "hkex" | "sec";
  statutoryDocumentId: string;
  statutoryDocumentUrl: string;
  sourceLocator: string;
  knowledgeDocumentId: string;
  contentKey: string;
  contentSha256: string;
  contentBytes: number;
  created: boolean;
  /** The import deliberately stops here; standard information processing is an explicit next local action. */
  processing: { status: "not_started"; endpoint: "/api/knowledge/processing-jobs"; documentId: string };
  limitations: string[];
};

const MAX_CONVERTED_MARKDOWN_BYTES = 2 * 1024 * 1024;

/**
 * Imports one already-indexed issuer/exchange/SEC filing into the normal local
 * knowledge ledger.  The caller supplies only the native registry document
 * identifier; a URL is never accepted from the client.  The materialized
 * content hash is part of the document/content key, so no prior local
 * materialization is overwritten.
 */
export async function importIndexedStatutoryDisclosureToKnowledge(
  env: Pick<Bindings, "DB" | "KNOWLEDGE_REPORT_CONVERTER_URL">,
  securityCode: string,
  statutoryDocumentId: string,
  importedAt = Date.now(),
): Promise<ImportIndexedStatutoryDisclosureResult> {
  const code = required(securityCode, "securityCode").toUpperCase();
  const documentId = required(statutoryDocumentId, "statutoryDocumentId");
  const row = await env.DB.prepare(`select registry, security_code as securityCode, document_id as documentId,
      title, published_at as publishedAt, document_url as documentUrl, document_type as documentType,
      source_locator as sourceLocator, indexed_at as indexedAt
    from research_statutory_disclosure_documents
    where security_code=? and document_id=?
    order by indexed_at desc limit 1`)
    .bind(code, documentId).first<Row>();
  if (!row) throw new Error("indexed statutory disclosure document not found; refresh the issuer/exchange index first");
  const disclosure = indexedDisclosure(row);
  assertOfficialDocumentUrl(disclosure);
  const converterUrl = localConverterUrl(env.KNOWLEDGE_REPORT_CONVERTER_URL, disclosure.registry);
  const converterDocumentId = `statutory_${disclosure.registry}_${hashSafe(disclosure.securityCode)}_${hashSafe(disclosure.documentId)}`;
  const response = await fetch(converterUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/markdown; charset=utf-8" },
    body: JSON.stringify({ docId: converterDocumentId, url: disclosure.documentUrl }),
  });
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`local statutory disclosure conversion failed: ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  const content = await response.text();
  const bytes = new TextEncoder().encode(content);
  if (bytes.byteLength === 0) throw new Error("local statutory disclosure conversion returned empty content");
  if (bytes.byteLength > MAX_CONVERTED_MARKDOWN_BYTES) {
    throw new Error(`local statutory disclosure conversion exceeded ${MAX_CONVERTED_MARKDOWN_BYTES} byte limit; split or review the source locally before processing`);
  }
  const contentSha256 = await sha256Hex(bytes);
  const sourceIdentity = await sha256Hex(new TextEncoder().encode([
    disclosure.registry, disclosure.securityCode, disclosure.documentId, disclosure.documentUrl, contentSha256,
  ].join("\u0000")));
  const knowledgeDocumentId = `statutory-${sourceIdentity.slice(0, 48)}`;
  const contentKey = `knowledge-content/local-statutory/${sourceIdentity.slice(0, 2)}/${sourceIdentity}-${contentSha256.slice(0, 12)}.md`;
  const existing = await env.DB.prepare("select doc_id from knowledge_docs where doc_id=?")
    .bind(knowledgeDocumentId).first<{ doc_id: string }>();
  if (!existing) {
    await insertImmutableKnowledgeDocument(env.DB, {
      disclosure, knowledgeDocumentId, contentKey, content, contentSha256, contentBytes: bytes.byteLength, importedAt,
    });
  }
  return {
    securityCode: disclosure.securityCode,
    registry: disclosure.registry,
    statutoryDocumentId: disclosure.documentId,
    statutoryDocumentUrl: disclosure.documentUrl,
    sourceLocator: disclosure.sourceLocator,
    knowledgeDocumentId,
    contentKey,
    contentSha256,
    contentBytes: bytes.byteLength,
    created: !existing,
    processing: { status: "not_started", endpoint: "/api/knowledge/processing-jobs", documentId: knowledgeDocumentId },
    limitations: [
      "仅导入已索引的发行人/交易所公开披露，并保留注册表 ID、精确 URL、locator、导入时间和转换后内容 SHA-256。",
      "转换后的本地知识文档按内容哈希追加保存；不会覆盖先前导入，也不保存或伪称已校验的原始 PDF 字节哈希。",
      "本操作不会调用 LLM、不会自动启动信息预处理、不会接受证据，也不会写入经营模型、情景或估值。",
    ],
  };
}

async function insertImmutableKnowledgeDocument(
  db: D1Database,
  input: { disclosure: IndexedStatutoryDisclosure; knowledgeDocumentId: string; contentKey: string; content: string; contentSha256: string; contentBytes: number; importedAt: number },
): Promise<void> {
  const { disclosure, knowledgeDocumentId, contentKey, content, contentSha256, contentBytes, importedAt } = input;
  const metadata = JSON.stringify({
    importKind: "indexed_statutory_disclosure.v1",
    statutoryDisclosure: {
      registry: disclosure.registry,
      securityCode: disclosure.securityCode,
      documentId: disclosure.documentId,
      documentUrl: disclosure.documentUrl,
      documentType: disclosure.documentType,
      sourceLocator: disclosure.sourceLocator,
      indexedAt: disclosure.indexedAt,
    },
    materializedContent: { sha256: contentSha256, bytes: contentBytes, format: "text/markdown; charset=utf-8" },
    importedAt,
  });
  const fetchedAt = new Date(importedAt).toISOString();
  const base64 = bytesToBase64(new TextEncoder().encode(content));
  const statements: D1PreparedStatement[] = [
    db.prepare(`insert into knowledge_docs (
      doc_id, source_type, report_type, source_name, title, url, published_at, fetched_at,
      event_time, target_name, target_code, discovery_method, access_method, summary,
      content_preview, metadata_json, recommendation_score, recommendation_level,
      recommendation_tags_json, recommendation_reasons_json, rank_score, source_weight,
      sort_time, source_name_normalized, target_code_normalized, updated_at
    ) values (?, 'company_announcement', 'statutory_disclosure', ?, ?, ?, ?, ?,
      ?, null, ?, 'indexed_statutory_disclosure', 'markdown_from_local_statutory_pdf', null,
      ?, ?, 0, null, ?, ?, 0, 0, ?, ?, ?, ?)
    on conflict(doc_id) do nothing`)
      .bind(
        knowledgeDocumentId, disclosure.registry === "cninfo" ? "CNINFO" : disclosure.registry === "hkex" ? "HKEXnews" : "SEC EDGAR", disclosure.title, disclosure.documentUrl,
        disclosure.publishedAt, fetchedAt, disclosure.publishedAt, disclosure.securityCode,
        content.slice(0, 600), metadata, JSON.stringify(["statutory_disclosure", disclosure.registry]), JSON.stringify([]),
        disclosure.publishedAt, disclosure.registry, disclosure.securityCode, importedAt,
      ),
    db.prepare(`insert into knowledge_doc_content_refs (
      doc_id, content_key, content_url, content_type, content_encoding, content_bytes, content_sha256, updated_at
    ) values (?, ?, '', 'text/markdown; charset=utf-8', 'identity', ?, ?, ?)
    on conflict(doc_id) do nothing`)
      .bind(knowledgeDocumentId, contentKey, contentBytes, contentSha256, importedAt),
    db.prepare(`insert into knowledge_local_content_cache (
      content_key, content_type, content_encoding, content_sha256, content_bytes, updated_at
    ) values (?, 'text/markdown; charset=utf-8', 'identity', ?, ?, ?)
    on conflict(content_key) do nothing`)
      .bind(contentKey, contentSha256, contentBytes, importedAt),
    db.prepare("insert into knowledge_doc_tags (doc_id, tag) values (?, ?) on conflict(doc_id, tag) do nothing")
      .bind(knowledgeDocumentId, "statutory_disclosure"),
    db.prepare("insert into knowledge_doc_tags (doc_id, tag) values (?, ?) on conflict(doc_id, tag) do nothing")
      .bind(knowledgeDocumentId, disclosure.registry),
    db.prepare("insert into knowledge_doc_security_links (doc_id, code) values (?, ?) on conflict(doc_id, code) do nothing")
      .bind(knowledgeDocumentId, disclosure.securityCode),
  ];
  const chunkSize = 20_000;
  for (let index = 0; index * chunkSize < base64.length; index += 1) {
    statements.push(db.prepare(`insert into knowledge_local_content_cache_chunks (content_key, chunk_index, payload_base64)
      values (?, ?, ?) on conflict(content_key, chunk_index) do nothing`)
      .bind(contentKey, index, base64.slice(index * chunkSize, (index + 1) * chunkSize)));
  }
  await db.batch(statements);
}

function indexedDisclosure(row: Row): IndexedStatutoryDisclosure {
  const registry = required(row.registry, "stored statutory registry");
  if (registry !== "cninfo" && registry !== "hkex" && registry !== "sec") throw new Error("indexed statutory disclosure registry is unsupported for local import");
  return {
    registry,
    securityCode: required(row.securityCode, "stored statutory securityCode").toUpperCase(),
    documentId: required(row.documentId, "stored statutory documentId"), title: required(row.title, "stored statutory title"),
    publishedAt: required(row.publishedAt, "stored statutory publishedAt"), documentUrl: required(row.documentUrl, "stored statutory documentUrl"),
    documentType: optional(row.documentType), sourceLocator: required(row.sourceLocator, "stored statutory sourceLocator"),
    indexedAt: finite(row.indexedAt, "stored statutory indexedAt"),
  };
}

function assertOfficialDocumentUrl(disclosure: IndexedStatutoryDisclosure): void {
  let url: URL;
  try { url = new URL(disclosure.documentUrl); } catch { throw new Error("indexed statutory disclosure URL is invalid"); }
  const host = url.hostname.toLowerCase();
  const allowed = disclosure.registry === "cninfo" ? ["static.cninfo.com.cn"] : disclosure.registry === "hkex" ? ["www1.hkexnews.hk"] : ["www.sec.gov"];
  const permittedPath = disclosure.registry === "sec"
    ? /^\/Archives\/edgar\/data\/\d+\/.+\.html?$/i.test(url.pathname)
    : url.pathname.toLowerCase().endsWith(".pdf");
  if (url.protocol !== "https:" || !allowed.includes(host) || !permittedPath) {
    if (disclosure.registry === "sec") throw new Error("indexed statutory disclosure URL is not an allowlisted SEC EDGAR HTML filing");
    throw new Error(`indexed statutory disclosure URL is not an allowlisted ${disclosure.registry.toUpperCase()} HTTPS PDF`);
  }
}

function localConverterUrl(value: string | undefined, registry: IndexedStatutoryDisclosure["registry"]): string {
  const raw = required(value, "KNOWLEDGE_REPORT_CONVERTER_URL");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("KNOWLEDGE_REPORT_CONVERTER_URL must be an absolute local HTTP URL"); }
  const host = url.hostname.toLowerCase();
  const expectedPath = registry === "sec" ? "/__convert-sec-filing" : "/__convert-report";
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(host) || url.pathname !== "/__convert-report") {
    throw new Error("KNOWLEDGE_REPORT_CONVERTER_URL must point to the local allowlisted report converter");
  }
  url.pathname = expectedPath;
  return url.toString();
}

function hashSafe(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "document"; }
function required(value: unknown, label: string): string { const text = String(value ?? "").trim(); if (!text) throw new Error(`${label} is required`); return text; }
function optional(value: unknown): string | null { const text = String(value ?? "").trim(); return text || null; }
function finite(value: unknown, label: string): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error(`${label} is invalid`); return result; }
async function sha256Hex(bytes: Uint8Array): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join(""); }
function bytesToBase64(bytes: Uint8Array): string { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
