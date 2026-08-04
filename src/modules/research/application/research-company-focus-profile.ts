import {
  assertFocusProfileInput,
  type ResearchCompanyFocusMembership,
  type ResearchCompanyFocusProfile,
  type ResearchCompanyFocusProfileItem,
  type ResearchFocusTargetKind,
} from "../domain/research-company-focus-profile";

type Row = Record<string, unknown>;
type FocusItemWrite = { role: string; targetKind: string; targetId: string; securityCode?: string | null; sortOrder?: number };
export type FocusProfileWrite = { focusProfileId?: string; companyId: string; asOf?: number; status?: "draft" | "reviewed"; title: string; reviewBy?: number | null; items: FocusItemWrite[]; createdAt?: number };

export type ResearchCompanyFocusProfileView = {
  availability: "available" | "empty" | "unavailable";
  reason: "no_profile" | "identity_not_found" | "storage_not_initialized" | null;
  profile: ResearchCompanyFocusProfile | null;
  membership?: Omit<ResearchCompanyFocusMembership, "ownerKey"> | null;
};

/** The public graph resolves only typed ledger targets.  This is intentionally
 * server-side: D1 cannot enforce polymorphic ownership with a foreign key. */
export async function loadResearchCompanyFocusProfile(db: D1Database, query: { companyId: string | null; securityCode: string; asOf: number; ownerKey?: string }): Promise<ResearchCompanyFocusProfileView> {
  if (!query.companyId) return { availability: "unavailable", reason: "identity_not_found", profile: null, ...(query.ownerKey ? { membership: null } : {}) };
  try {
    const row = await db.prepare(`select * from research_company_focus_profile_versions
      where company_id=? and as_of<=? and status!='superseded' order by as_of desc, version desc, created_at desc limit 1`).bind(query.companyId, query.asOf).first<Row>();
    const membership = query.ownerKey ? await loadMembership(db, query.companyId, query.ownerKey) : undefined;
    if (!row) return { availability: "empty", reason: "no_profile", profile: null, ...(query.ownerKey ? { membership } : {}) };
    const profile = mapProfile(row);
    const rows = await db.prepare(`select * from research_company_focus_profile_items where focus_profile_id=? order by role, sort_order, focus_item_id`).bind(profile.focusProfileId).all<Row>();
    profile.items = await Promise.all(rows.results.map(async (item) => resolveStoredItem(db, query.companyId!, query.securityCode, item)));
    return { availability: "available", reason: null, profile, ...(query.ownerKey ? { membership } : {}) };
  } catch (error) {
    if (missing(error, "research_company_focus_profile_versions")) return { availability: "unavailable", reason: "storage_not_initialized", profile: null, ...(query.ownerKey ? { membership: null } : {}) };
    throw error;
  }
}

export async function appendResearchCompanyFocusMembership(db: D1Database, input: { membershipId?: string; ownerKey: string; companyId: string; status: "active" | "removed"; createdAt?: number }) {
  const ownerKey = required(input.ownerKey, "ownerKey"); const companyId = required(input.companyId, "companyId"); const now = input.createdAt ?? Date.now();
  const prior = await loadMembershipRaw(db, companyId, ownerKey);
  const membership: ResearchCompanyFocusMembership = { membershipId: input.membershipId ?? `focus-membership:${crypto.randomUUID()}`, ownerKey, companyId, status: input.status, supersedesMembershipId: prior?.membershipId ?? null, createdAt: now };
  await db.prepare(`insert into research_company_focus_memberships (membership_id, owner_key, company_id, status, supersedes_membership_id, created_at) values (?, ?, ?, ?, ?, ?)`)
    .bind(membership.membershipId, membership.ownerKey, membership.companyId, membership.status, membership.supersedesMembershipId, membership.createdAt).run();
  const { ownerKey: _ownerKey, ...publicMembership } = membership;
  return { state: "saved" as const, membership: publicMembership };
}

export async function createResearchCompanyFocusProfile(db: D1Database, input: FocusProfileWrite) {
  const now = input.createdAt ?? Date.now(); const status = input.status ?? "draft"; const asOf = input.asOf ?? now;
  assertFocusProfileInput({ companyId: input.companyId, asOf, status, title: input.title, reviewBy: input.reviewBy, items: input.items });
  const company = await db.prepare(`select company_id as companyId from research_operating_companies where company_id=?`).bind(input.companyId).first<Row>();
  if (!company) throw new Error("focus profile requires a confirmed operating company");
  const prior = await db.prepare(`select focus_profile_id as focusProfileId, version from research_company_focus_profile_versions where company_id=? order by version desc limit 1`).bind(input.companyId).first<Row>();
  const profileId = input.focusProfileId ?? `focus-profile:${crypto.randomUUID()}`; const version = Number(prior?.version ?? 0) + 1;
  const resolved = await Promise.all(input.items.map((item) => resolveFocusTarget(db, input.companyId, item)));
  await db.batch([
    db.prepare(`insert into research_company_focus_profile_versions (focus_profile_id, company_id, version, supersedes_focus_profile_id, as_of, status, title, review_by, epistemic_type, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, 'system_judgment', ?)`)
      .bind(profileId, input.companyId, version, prior?.focusProfileId ?? null, asOf, status, required(input.title, "focus profile title"), input.reviewBy ?? null, now),
    ...(prior ? [db.prepare(`update research_company_focus_profile_versions set status='superseded' where focus_profile_id=?`).bind(prior.focusProfileId)] : []),
    ...resolved.map(({ item }, index) => db.prepare(`insert into research_company_focus_profile_items (focus_item_id, focus_profile_id, role, target_kind, target_id, security_code, sort_order, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(`focus-item:${crypto.randomUUID()}`, profileId, item.role, item.targetKind, item.targetId, item.securityCode ?? null, Number.isFinite(item.sortOrder) ? Math.floor(item.sortOrder!) : index, now)),
  ]);
  return { state: "saved" as const, focusProfileId: profileId, version, supersedesFocusProfileId: prior?.focusProfileId ?? null };
}

async function resolveStoredItem(db: D1Database, companyId: string, securityCode: string, row: Row): Promise<ResearchCompanyFocusProfileItem> {
  const item = { role: text(row.role), targetKind: text(row.target_kind), targetId: text(row.target_id), securityCode: optional(row.security_code), sortOrder: number(row.sort_order), focusItemId: text(row.focus_item_id), createdAt: number(row.created_at) };
  try { const target = await resolveFocusTarget(db, companyId, item); return { ...item, target: target.target, unavailableReason: null } as ResearchCompanyFocusProfileItem; }
  catch (error) { return { ...item, target: null, unavailableReason: error instanceof Error ? error.message : String(error) } as ResearchCompanyFocusProfileItem; }
}

async function resolveFocusTarget(db: D1Database, companyId: string, item: FocusItemWrite): Promise<{ item: FocusItemWrite; target: Record<string, unknown> }> {
  const kind = item.targetKind as ResearchFocusTargetKind; const targetId = required(item.targetId, "focus targetId");
  const sql: Record<ResearchFocusTargetKind, { query: string; fields: string[]; security?: boolean }> = {
    operating_model: { query: `select operating_model_id as id, as_of as asOf, status, primary_earning_driver as title, summary from research_operating_models_typed model where operating_model_id=? and company_id=? and epistemic_type in ('observed_fact','management_guidance','system_judgment') and exists (select 1 from research_operating_market_evidence_refs evidence where evidence.subject_type='operating_model' and evidence.subject_id=model.operating_model_id)`, fields: ["id", "asOf", "status", "title", "summary"] },
    operating_driver_plan: { query: `select plan.operating_driver_plan_id as id, model.as_of as asOf, plan.status, plan.scenario_name as title, plan.valuation_currency as currency from research_operating_driver_plans plan join research_operating_models_typed model on model.operating_model_id=plan.operating_model_id where plan.operating_driver_plan_id=? and model.company_id=? and exists (select 1 from research_operating_market_evidence_refs evidence where evidence.subject_type='driver_plan' and evidence.subject_id=plan.operating_driver_plan_id)`, fields: ["id", "asOf", "status", "title", "currency"] },
    operating_source_fact: { query: `select operating_source_fact_id as id, period_label as asOf, subject_label as title, statement, source_security_code as securityCode from research_operating_source_facts where operating_source_fact_id=? and operating_company_id=?`, fields: ["id", "asOf", "title", "statement", "securityCode"], security: true },
    industry_kpi_driver_binding: { query: `select binding.industry_kpi_driver_binding_id as id, binding.mapped_at as asOf, kpi.name as title, binding.mapping_note as summary, binding.security_code as securityCode from research_industry_kpi_driver_bindings binding join research_company_track_exposures exposure on exposure.company_track_exposure_id=binding.company_track_exposure_id join research_industry_track_kpis kpi on kpi.kpi_id=binding.industry_kpi_id where binding.industry_kpi_driver_binding_id=? and exposure.company_id=?`, fields: ["id", "asOf", "title", "summary", "securityCode"], security: true },
    financial_specialty_fact: { query: `select financial_specialty_fact_id as id, as_of as asOf, reported_label as title, statement, security_code as securityCode from research_financial_specialty_fact_versions where financial_specialty_fact_id=? and company_id=?`, fields: ["id", "asOf", "title", "statement", "securityCode"], security: true },
    operating_segment: { query: `select segment.operating_segment_id as id, model.as_of as asOf, segment.name as title, segment.product_scope as summary from research_operating_model_segments_typed segment join research_operating_models_typed model on model.operating_model_id=segment.operating_model_id where segment.operating_segment_id=? and model.company_id=? and exists (select 1 from research_operating_market_evidence_refs evidence where evidence.subject_type='operating_segment' and evidence.subject_id=segment.operating_segment_id)`, fields: ["id", "asOf", "title", "summary"] },
    risk_relationship: { query: `select relationship_id as id, as_of as asOf, counterparty_name as title, description as summary, security_code as securityCode from research_risk_relationships where relationship_id=? and company_id=? and source_refs_json!='[]'`, fields: ["id", "asOf", "title", "summary", "securityCode"], security: true },
    research_thesis: { query: `select thesis_id as id, as_of as asOf, title, statement as summary from research_theses thesis where thesis_id=? and company_id=? and assessment_type='system_assessment' and exists (select 1 from research_thesis_evidence evidence where evidence.thesis_id=thesis.thesis_id)`, fields: ["id", "asOf", "title", "summary"] },
    governance_record: { query: `select governance_record_id as id, as_of as asOf, title, summary from research_governance_records where governance_record_id=? and company_id=? and source_refs_json!='[]'`, fields: ["id", "asOf", "title", "summary"] },
    governance_capital_fact: { query: `select governance_capital_fact_version_id as id, as_of as asOf, fact_key as title, coalesce(value_text, cast(value_number as text)) as summary, security_code as securityCode from research_governance_capital_fact_versions where governance_capital_fact_version_id=? and company_id=?`, fields: ["id", "asOf", "title", "summary", "securityCode"], security: true },
    research_catalyst: { query: `select catalyst_id as id, event_at as asOf, title, impacted_assumption as summary, security_code as securityCode from research_catalysts where catalyst_id=? and company_id=? and source_refs_json!='[]'`, fields: ["id", "asOf", "title", "summary", "securityCode"], security: true },
    research_risk: { query: `select risk_id as id, as_of as asOf, title, transmission as summary, security_code as securityCode from research_risk_entries where risk_id=? and company_id=? and scope in ('operating_company','listed_security') and source_refs_json!='[]'`, fields: ["id", "asOf", "title", "summary", "securityCode"], security: true },
    market_structure_fact: { query: `select fact.market_structure_fact_id as id, fact.as_of as asOf, fact.fact_key as title, coalesce(fact.value_text, cast(fact.value_number as text)) as summary, fact.security_code as securityCode from research_market_structure_facts fact join research_listed_securities security on security.security_code=fact.security_code where fact.market_structure_fact_id=? and security.company_id=? and fact.fact_status='verified' and fact.epistemic_type='observed_fact'`, fields: ["id", "asOf", "title", "summary", "securityCode"], security: true },
  };
  const statement = sql[kind]; if (!statement) throw new Error("focus target kind is not supported");
  const row = await db.prepare(statement.query).bind(targetId, companyId).first<Row>();
  if (!row) throw new Error("focus target is unavailable, cross-company, personal, or lacks its evidence gate");
  const targetSecurity = optional(row.securityCode); if (item.securityCode && targetSecurity !== item.securityCode.toUpperCase()) throw new Error("focus item securityCode does not match the referenced security target");
  return { item: { ...item, securityCode: targetSecurity ?? null }, target: Object.fromEntries(statement.fields.map((field) => [field, row[field]])) };
}

async function loadMembership(db: D1Database, companyId: string, ownerKey: string) { const row = await loadMembershipRaw(db, companyId, ownerKey); return row ? { membershipId: row.membershipId, companyId: row.companyId, status: row.status, supersedesMembershipId: row.supersedesMembershipId, createdAt: row.createdAt } : null; }
async function loadMembershipRaw(db: D1Database, companyId: string, ownerKey: string): Promise<ResearchCompanyFocusMembership | null> { const row = await db.prepare(`select * from research_company_focus_memberships where company_id=? and owner_key=? order by created_at desc, membership_id desc limit 1`).bind(companyId, ownerKey).first<Row>(); return row ? { membershipId: text(row.membership_id), ownerKey: text(row.owner_key), companyId: text(row.company_id), status: text(row.status) as ResearchCompanyFocusMembership["status"], supersedesMembershipId: optional(row.supersedes_membership_id), createdAt: number(row.created_at) } : null; }
function mapProfile(row: Row): ResearchCompanyFocusProfile { return { focusProfileId: text(row.focus_profile_id), companyId: text(row.company_id), version: number(row.version), supersedesFocusProfileId: optional(row.supersedes_focus_profile_id), asOf: number(row.as_of), status: text(row.status) as ResearchCompanyFocusProfile["status"], title: text(row.title), reviewBy: nullableNumber(row.review_by), epistemicType: "system_judgment", createdAt: number(row.created_at), items: [] }; }
function required(value: unknown, label: string) { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; } function text(value: unknown) { return required(value, "stored focus profile field"); } function optional(value: unknown) { const result = String(value ?? "").trim(); return result || null; } function number(value: unknown) { const result = Number(value); if (!Number.isFinite(result)) throw new Error("stored focus profile number is invalid"); return result; } function nullableNumber(value: unknown) { return value === null || value === undefined || value === "" ? null : number(value); } function missing(error: unknown, table: string) { return String(error).includes(`no such table: ${table}`); }
