import type { Bindings } from "../../../types";
import { ingestEvidence } from "./situation-service";
import { D1SituationRepository } from "./situation-repository";

type KnowledgeScope = "knowledge_docs" | "knowledge_filtered_docs";
type KnowledgeRow = {
  docId: string; sourceType: string; reportType: string | null; sourceName: string | null; title: string; url: string | null;
  publishedAt: string | null; fetchedAt: string | null; eventTime: string | null; targetName: string | null; targetCode: string | null;
  summary: string | null; contentPreview: string | null; metadataJson: string | null;
};
type ImportStats = { scanned: number; imported: number; deduplicated: number; skippedNoSourceUrl: number; failed: number };

const KNOWLEDGE_BATCH_SIZE = 100;

/**
 * Transfers already-persisted knowledge into the situation evidence ledger.
 * A topic rejection is a routing decision, not data loss: both the selected
 * knowledge feed and the filtered lead inbox are imported as single-source
 * leads. The downstream event rules remain responsible for confirmation.
 */
export async function syncSituationKnowledgeEvidence(env: Bindings, now = Date.now()): Promise<ImportStats> {
  const repository = new D1SituationRepository(env.DB);
  const stats: ImportStats = { scanned: 0, imported: 0, deduplicated: 0, skippedNoSourceUrl: 0, failed: 0 };
  for (const scope of ["knowledge_docs", "knowledge_filtered_docs"] as const) {
    const source = sourceForScope(scope);
    await repository.upsertSource({ sourceId: source.sourceId, name: source.name, kind: "knowledge_inbox", config: { scope, evidenceGrade: "single_source_lead" }, state: "healthy", now });
    const rows = await listPendingRows(env.DB, scope);
    for (const row of rows) {
      stats.scanned += 1;
      const url = text(row.url);
      if (!isHttpUrl(url)) {
        await recordImport(env.DB, scope, row.docId, "skipped_no_source_url", null, "缺少可追溯的原始 URL", now);
        stats.skippedNoSourceUrl += 1;
        continue;
      }
      try {
        const result = await ingestEvidence(repository, {
          sourceId: source.sourceId,
          sourceName: source.name,
          sourceKind: "knowledge_inbox",
          externalId: row.docId,
          url,
          title: row.title,
          excerpt: text(row.summary) || text(row.contentPreview) || null,
          publishedAt: timestamp(row.eventTime) ?? timestamp(row.publishedAt) ?? timestamp(row.fetchedAt) ?? now,
          fetchedAt: timestamp(row.fetchedAt) ?? now,
          entities: entitiesFor(row),
          metadata: {
            knowledgeDocId: row.docId,
            knowledgeScope: scope,
            sourceType: row.sourceType,
            reportType: row.reportType,
            targetName: row.targetName,
            sourceName: row.sourceName,
            topicRoute: scope === "knowledge_filtered_docs" ? "low_priority_lead" : "selected_feed",
          },
          evidenceGrade: "single_source_lead",
        }, now);
        await recordImport(env.DB, scope, row.docId, "imported", result.evidence.evidenceId, result.created ? null : "evidence_deduplicated", now);
        if (result.created) stats.imported += 1;
        else stats.deduplicated += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await recordImport(env.DB, scope, row.docId, "failed", null, reason.slice(0, 1000), now);
        stats.failed += 1;
        await repository.upsertSource({ sourceId: source.sourceId, name: source.name, kind: "knowledge_inbox", state: "failed", error: reason.slice(0, 1000), now });
      }
    }
  }
  return stats;
}

async function listPendingRows(db: D1Database, scope: KnowledgeScope): Promise<KnowledgeRow[]> {
  const table = scope === "knowledge_docs" ? "knowledge_docs" : "knowledge_filtered_docs";
  const contentPreview = scope === "knowledge_docs" ? "d.summary as contentPreview" : "d.content_preview as contentPreview";
  const rows = await db.prepare(`select d.doc_id as docId, d.source_type as sourceType, d.report_type as reportType, d.source_name as sourceName,
      d.title, d.url, d.published_at as publishedAt, d.fetched_at as fetchedAt, d.event_time as eventTime,
      d.target_name as targetName, d.target_code as targetCode, d.summary, ${contentPreview}, d.metadata_json as metadataJson
    from ${table} d left join situation_knowledge_imports i on i.source_scope=? and i.doc_id=d.doc_id
    where i.doc_id is null or i.status='failed'
    order by coalesce(nullif(d.event_time, ''), nullif(d.published_at, ''), nullif(d.fetched_at, '')) desc, d.doc_id desc limit ?`)
    .bind(scope, KNOWLEDGE_BATCH_SIZE).all<KnowledgeRow>();
  return rows.results ?? [];
}

async function recordImport(db: D1Database, scope: KnowledgeScope, docId: string, status: "imported" | "skipped_no_source_url" | "failed", evidenceId: string | null, reason: string | null, now: number): Promise<void> {
  await db.prepare(`insert into situation_knowledge_imports (source_scope, doc_id, status, evidence_id, reason, first_seen_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?)
    on conflict(source_scope, doc_id) do update set status=excluded.status, evidence_id=excluded.evidence_id, reason=excluded.reason, updated_at=excluded.updated_at`)
    .bind(scope, docId, status, evidenceId, reason, now, now).run();
}

function sourceForScope(scope: KnowledgeScope): { sourceId: string; name: string } {
  return scope === "knowledge_docs"
    ? { sourceId: "knowledge:selected-feed", name: "知识库已选内容" }
    : { sourceId: "knowledge:lead-inbox", name: "知识库低优先级线索" };
}
function entitiesFor(row: KnowledgeRow): string[] {
  const metadata = parseObject(row.metadataJson);
  const linked = Array.isArray(metadata.stockLinks) ? metadata.stockLinks : [];
  const codes = [row.targetCode, ...(Array.isArray(metadata.stockCodes) ? metadata.stockCodes : []), ...linked.map((item) => typeof item === "object" && item ? (item as Record<string, unknown>).code : "")]
    .map((item) => text(item).toUpperCase()).filter(isSecurityCode);
  return [...new Set(codes)];
}
function parseObject(value: string | null): Record<string, unknown> { try { const parsed = JSON.parse(value ?? "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim(); }
function timestamp(value: string | null): number | null { const parsed = Date.parse(text(value)); return Number.isFinite(parsed) ? parsed : null; }
function isHttpUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:"; } catch { return false; } }
function isSecurityCode(value: string): boolean { return /^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK|[A-Z.]{1,12}\.US)$/.test(value); }
