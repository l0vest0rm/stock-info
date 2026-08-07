import {
  assertResearchFinancialProfileRecord,
  resolveResearchFinancialProfile,
  type ResearchFinancialEntityType,
  type ResearchFinancialProfileAuthority,
  type ResearchFinancialProfileRecord,
} from "../domain/research-financial-profile";
import { requireConfirmedSecurityCompanyScope } from "./research-company-scope";

type Row = Record<string, unknown>;
export type ResearchFinancialProfileWrite = {
  financialProfileId: string;
  securityCode: string;
  entityType: ResearchFinancialEntityType;
  asOf: string;
  sourceAuthority: ResearchFinancialProfileAuthority;
  sourceUrl: string;
  sourceTitle: string;
  sourceNote: string;
  recordedBy?: string;
  recordedAt?: number;
};

export async function appendResearchFinancialProfile(db: D1Database, input: ResearchFinancialProfileWrite): Promise<ResearchFinancialProfileRecord> {
  const scope = await requireConfirmedSecurityCompanyScope(db, input.securityCode, "financial profile");
  const now = input.recordedAt ?? Date.now();
  const record: ResearchFinancialProfileRecord = {
    financialProfileId: required(input.financialProfileId, "financialProfileId"), companyId: scope.companyId, sourceSecurityCode: scope.securityCode,
    entityType: input.entityType, asOf: required(input.asOf, "asOf"), sourceAuthority: input.sourceAuthority,
    sourceUrl: required(input.sourceUrl, "sourceUrl"), sourceTitle: required(input.sourceTitle, "sourceTitle"), sourceNote: required(input.sourceNote, "sourceNote"),
    recordedBy: required(input.recordedBy ?? "local-user", "recordedBy"), recordedAt: now, createdAt: now,
  };
  assertResearchFinancialProfileRecord(record);
  await db.prepare(`insert into research_company_financial_profiles (
    financial_profile_id, company_id, source_security_code, entity_type, as_of, source_authority, source_url, source_title, source_note, recorded_by, recorded_at, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(record.financialProfileId, record.companyId, record.sourceSecurityCode, record.entityType, record.asOf, record.sourceAuthority, record.sourceUrl, record.sourceTitle, record.sourceNote, record.recordedBy, record.recordedAt, record.createdAt).run();
  return record;
}

export async function loadResearchFinancialProfile(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  let historical: Row[] = [];
  let automatic: Row[] = [];
  let readable = false;
  try {
    const rows = await db.prepare(`select p.financial_profile_id as financialProfileId, p.company_id as companyId, p.source_security_code as sourceSecurityCode,
      p.entity_type as entityType, p.as_of as asOf, p.source_authority as sourceAuthority, p.source_url as sourceUrl, p.source_title as sourceTitle,
      p.source_note as sourceNote, p.recorded_by as recordedBy, p.recorded_at as recordedAt, p.created_at as createdAt
      from research_company_financial_profiles p where p.company_id=(select company_id from research_listed_securities where security_code=?)
      order by p.as_of desc, p.recorded_at desc, p.financial_profile_id desc`).bind(code).all<Row>();
    historical = rows.results; readable = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such table|does not exist|not found/i.test(message)) throw error;
  }
  try {
    const rows = await db.prepare(`select profile.auto_financial_profile_id as financialProfileId, profile.operating_company_id as companyId,
      profile.security_code as sourceSecurityCode, profile.entity_type as entityType, profile.as_of as asOf, profile.source_url as sourceUrl,
      profile.source_title as sourceTitle, profile.source_note as sourceNote, profile.processed_at as recordedAt, profile.materialized_at as createdAt
      from research_auto_filing_financial_profiles profile
      join research_auto_filing_fact_inputs input on input.filing_fact_input_id=profile.source_filing_fact_input_id
      where profile.security_code=? and input.validity_status='current'
      order by profile.as_of desc, profile.processed_at desc, profile.auto_financial_profile_id desc`).bind(code).all<Row>();
    automatic = rows.results; readable = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such table|does not exist|not found/i.test(message)) throw error;
  }
  if (!readable) return { availability: "unavailable" as const, status: "unknown" as const, entityType: null, qualityEntityType: "unknown" as const, asOf: null, reason: "金融实体类型账本尚未初始化；通用非金融指标保持阻断。", records: [] as ResearchFinancialProfileRecord[] };
  return resolveResearchFinancialProfile([
    ...historical.map(mapRecord),
    ...automatic.map(mapAutomaticRecord),
  ]);
}

function mapRecord(row: Row): ResearchFinancialProfileRecord { return {
  financialProfileId: text(row.financialProfileId), companyId: text(row.companyId), sourceSecurityCode: text(row.sourceSecurityCode), entityType: text(row.entityType) as ResearchFinancialEntityType,
  asOf: text(row.asOf), sourceAuthority: text(row.sourceAuthority) as ResearchFinancialProfileAuthority, sourceUrl: text(row.sourceUrl), sourceTitle: text(row.sourceTitle), sourceNote: text(row.sourceNote), recordedBy: text(row.recordedBy), recordedAt: number(row.recordedAt), createdAt: number(row.createdAt),
}; }
function mapAutomaticRecord(row: Row): ResearchFinancialProfileRecord { return {
  financialProfileId: text(row.financialProfileId), companyId: text(row.companyId), sourceSecurityCode: text(row.sourceSecurityCode), entityType: text(row.entityType) as ResearchFinancialEntityType,
  asOf: text(row.asOf), sourceAuthority: "issuer_disclosure", sourceUrl: text(row.sourceUrl), sourceTitle: text(row.sourceTitle), sourceNote: text(row.sourceNote),
  recordedBy: "system:auto-filing-financial-profile.v1", recordedAt: number(row.recordedAt), createdAt: number(row.createdAt),
}; }
function required(value: unknown, label: string): string { const text = String(value ?? "").trim(); if (!text) throw new Error(`${label} is required`); return text; }
function text(value: unknown): string { return required(value, "stored financial profile value"); }
function number(value: unknown): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error("stored financial profile timestamp is invalid"); return result; }
