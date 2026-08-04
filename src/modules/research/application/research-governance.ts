import { assertSourceReferences, type ResearchEpistemicType, type ResearchSourceReference } from "../domain/research-dossier";

export type ResearchGovernanceRecord = {
  governanceRecordId: string;
  companyId: string;
  asOf: number;
  dimension: "management_capability" | "guidance_credibility" | "governance" | "alignment" | "capital_allocation";
  title: string;
  statement: string;
  status: "draft" | "reviewed" | "superseded";
  epistemicType: Exclude<ResearchEpistemicType, "user_decision">;
  sourceReferences: ResearchSourceReference[];
  createdAt: number;
  updatedAt: number;
};

export async function loadResearchGovernance(db: D1Database, companyId: string | null, asOf: number) {
  if (!companyId) return { availability: "unavailable", reason: "identity_not_found", items: [] as ResearchGovernanceRecord[] };
  try {
    const rows = await db.prepare(`select governance_record_id as governanceRecordId, company_id as companyId, as_of as asOf,
      dimension, title, statement, status, epistemic_type as epistemicType, source_refs_json as sourceRefsJson,
      created_at as createdAt, updated_at as updatedAt from research_governance_records
      where company_id=? and as_of<=? and status<>'superseded' order by dimension, as_of desc, created_at desc`)
      .bind(companyId, asOf).all<Record<string, unknown>>();
    return { availability: rows.results.length ? "available" : "empty", reason: rows.results.length ? null : "no_records", items: rows.results.map(mapRecord) };
  } catch (error) {
    if (/no such table.*research_governance_records/i.test(error instanceof Error ? error.message : String(error))) return { availability: "unavailable", reason: "storage_not_initialized", items: [] as ResearchGovernanceRecord[] };
    throw error;
  }
}

export async function insertResearchGovernance(db: D1Database, input: ResearchGovernanceRecord) {
  assertSourceReferences(input.epistemicType, input.sourceReferences);
  await db.prepare(`insert into research_governance_records (
    governance_record_id, company_id, as_of, dimension, title, statement, status, epistemic_type, source_refs_json, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.governanceRecordId, input.companyId, input.asOf, input.dimension, input.title, input.statement,
      input.status, input.epistemicType, JSON.stringify(input.sourceReferences), input.createdAt, input.updatedAt).run();
  return { state: "saved" as const, recordId: input.governanceRecordId };
}

function mapRecord(row: Record<string, unknown>): ResearchGovernanceRecord {
  const refs = parseReferences(row.sourceRefsJson);
  const record: ResearchGovernanceRecord = {
    governanceRecordId: required(row.governanceRecordId), companyId: required(row.companyId), asOf: Number(row.asOf),
    dimension: required(row.dimension) as ResearchGovernanceRecord["dimension"], title: required(row.title), statement: required(row.statement),
    status: required(row.status) as ResearchGovernanceRecord["status"], epistemicType: required(row.epistemicType) as ResearchGovernanceRecord["epistemicType"],
    sourceReferences: refs, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt),
  };
  assertSourceReferences(record.epistemicType, record.sourceReferences);
  return record;
}
function parseReferences(value: unknown): ResearchSourceReference[] { try { const p = JSON.parse(String(value || "[]")); return Array.isArray(p) ? p : []; } catch { throw new Error("invalid governance source references"); } }
function required(value: unknown): string { const result = String(value || "").trim(); if (!result) throw new Error("governance record has incomplete data"); return result; }
