import {
  assertResearchIndustryKpiDriverBinding,
  findResearchIndustryKpiTransmissionRule,
  researchIndustryKpiTransmissionConfigVersion,
  type IndustryKpiDriverBindingWrite,
  type ResearchIndustryKpiDriverBinding,
} from "../domain/research-industry-kpi-transmission";
import type { ResearchSourceReference } from "../domain/research-dossier";

type Row = Record<string, unknown>;

/** Writes only an explicit researcher mapping; it cannot modify a driver plan. */
export async function insertResearchIndustryKpiDriverBinding(db: D1Database, input: IndustryKpiDriverBindingWrite): Promise<ResearchIndustryKpiDriverBinding> {
  const source = await loadBindingScope(db, input);
  assertResearchIndustryKpiDriverBinding(input, { targetModule: text(source.targetModule), targetField: text(source.targetField) });
  const rule = findResearchIndustryKpiTransmissionRule(input.transmissionRuleId);
  const createdAt = input.createdAt ?? input.mappedAt;
  await db.prepare(`insert into research_industry_kpi_driver_bindings (
    industry_kpi_driver_binding_id, security_code, evidence_reference_id, company_track_exposure_id, industry_kpi_id,
    operating_driver_plan_id, operating_driver_segment_year_id, transmission_rule_id, mapping_config_version,
    input_value, input_unit, mapping_note, mapped_by, mapped_at, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.industryKpiDriverBindingId, input.securityCode.toUpperCase(), input.evidenceReferenceId, input.companyTrackExposureId, input.industryKpiId,
      input.operatingDriverPlanId, input.operatingDriverSegmentYearId, rule.ruleId, researchIndustryKpiTransmissionConfigVersion(), input.inputValue,
      input.inputUnit.trim(), input.mappingNote.trim(), input.mappedBy.trim(), input.mappedAt, createdAt).run();
  return mapBinding({ ...source, industryKpiDriverBindingId: input.industryKpiDriverBindingId, securityCode: input.securityCode.toUpperCase(), evidenceReferenceId: input.evidenceReferenceId, companyTrackExposureId: input.companyTrackExposureId, industryKpiId: input.industryKpiId, operatingDriverPlanId: input.operatingDriverPlanId, operatingDriverSegmentYearId: input.operatingDriverSegmentYearId, transmissionRuleId: rule.ruleId, mappingConfigVersion: researchIndustryKpiTransmissionConfigVersion(), inputValue: input.inputValue, inputUnit: input.inputUnit, mappingNote: input.mappingNote, mappedBy: input.mappedBy, mappedAt: input.mappedAt, createdAt });
}

export async function loadResearchIndustryKpiDriverBindings(db: D1Database, securityCode: string, operatingDriverPlanId?: string): Promise<ResearchIndustryKpiDriverBinding[]> {
  const rows = await db.prepare(`select binding.industry_kpi_driver_binding_id as industryKpiDriverBindingId, binding.security_code as securityCode,
      binding.evidence_reference_id as evidenceReferenceId, binding.company_track_exposure_id as companyTrackExposureId,
      binding.industry_kpi_id as industryKpiId, kpi.name as industryKpiName, binding.operating_driver_plan_id as operatingDriverPlanId,
      binding.operating_driver_segment_year_id as operatingDriverSegmentYearId, binding.transmission_rule_id as transmissionRuleId,
      binding.mapping_config_version as mappingConfigVersion, binding.input_value as inputValue, binding.input_unit as inputUnit,
      binding.mapping_note as mappingNote, binding.mapped_by as mappedBy, binding.mapped_at as mappedAt, binding.created_at as createdAt,
      evidence.information_id as informationId, evidence.version_id as versionId, evidence.doc_id as documentId,
      evidence.source_url as sourceUrl, evidence.content_url as contentUrl, evidence.title, evidence.source_name as sourceName,
      evidence.published_at as publishedAt, evidence.locator
    from research_industry_kpi_driver_bindings binding
    join research_industry_track_kpis kpi on kpi.kpi_id=binding.industry_kpi_id
    join research_reusable_evidence_references evidence on evidence.evidence_reference_id=binding.evidence_reference_id
    where binding.security_code=? and (? is null or binding.operating_driver_plan_id=?)
    order by binding.mapped_at desc, binding.industry_kpi_driver_binding_id desc`).bind(required(securityCode, "securityCode").toUpperCase(), operatingDriverPlanId ?? null, operatingDriverPlanId ?? null).all<Row>();
  return rows.results.map(mapBinding);
}

async function loadBindingScope(db: D1Database, input: IndustryKpiDriverBindingWrite): Promise<Row> {
  const row = await db.prepare(`select candidate.target_module as targetModule, candidate.target_field as targetField, kpi.name as industryKpiName,
      evidence.information_id as informationId, evidence.version_id as versionId, evidence.doc_id as documentId,
      evidence.source_url as sourceUrl, evidence.content_url as contentUrl, evidence.title, evidence.source_name as sourceName,
      evidence.published_at as publishedAt, evidence.locator
    from research_reusable_evidence_references evidence
    join research_information_evidence_candidates candidate on candidate.candidate_id=evidence.candidate_id
    join research_information_evidence_candidate_reviews accepted_review on accepted_review.candidate_review_id=evidence.candidate_review_id and accepted_review.decision='accepted'
    join research_company_track_exposures exposure on exposure.company_track_exposure_id=?
    join research_listed_securities security on security.security_code=evidence.security_code
      and security.company_id=exposure.company_id and security.mapping_status='confirmed'
    join research_industry_track_kpis kpi on kpi.kpi_id=? and kpi.track_profile_id=exposure.track_profile_id
    join research_operating_driver_plans plan on plan.operating_driver_plan_id=?
    join research_operating_models_typed model on model.operating_model_id=plan.operating_model_id and model.company_id=exposure.company_id
    join research_operating_driver_segment_years segment on segment.operating_driver_segment_year_id=?
    join research_operating_driver_plan_years plan_year on plan_year.operating_driver_plan_year_id=segment.operating_driver_plan_year_id and plan_year.operating_driver_plan_id=plan.operating_driver_plan_id
    where evidence.evidence_reference_id=? and evidence.security_code=?`).bind(input.companyTrackExposureId, input.industryKpiId, input.operatingDriverPlanId, input.operatingDriverSegmentYearId, input.evidenceReferenceId, input.securityCode.toUpperCase()).first<Row>();
  if (!row) throw new Error("industry KPI binding must use accepted evidence from a confirmed security of the matching company, exposure/KPI, and driver-plan segment");
  return row;
}

function mapBinding(row: Row): ResearchIndustryKpiDriverBinding {
  const sourceReference: ResearchSourceReference = { sourceKind: "research_record", sourceId: text(row.evidenceReferenceId), informationId: text(row.informationId), versionId: text(row.versionId), documentId: text(row.documentId), url: optional(row.sourceUrl) ?? optional(row.contentUrl) ?? undefined, title: optional(row.title) ?? optional(row.sourceName) ?? undefined, publishedAt: optional(row.publishedAt) ?? undefined, locator: text(row.locator) };
  return { industryKpiDriverBindingId: text(row.industryKpiDriverBindingId), securityCode: text(row.securityCode), evidenceReferenceId: text(row.evidenceReferenceId), companyTrackExposureId: text(row.companyTrackExposureId), industryKpiId: text(row.industryKpiId), industryKpiName: text(row.industryKpiName), operatingDriverPlanId: text(row.operatingDriverPlanId), operatingDriverSegmentYearId: text(row.operatingDriverSegmentYearId), transmissionRuleId: text(row.transmissionRuleId), mappingConfigVersion: text(row.mappingConfigVersion), inputValue: num(row.inputValue), inputUnit: text(row.inputUnit), mappingNote: text(row.mappingNote), mappedBy: text(row.mappedBy), mappedAt: num(row.mappedAt), createdAt: num(row.createdAt), sourceReference };
}
function required(value: string | undefined, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function text(value: unknown): string { return required(value === null || value === undefined ? "" : String(value), "stored industry KPI binding field"); }
function optional(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function num(value: unknown): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error("stored industry KPI binding number is invalid"); return result; }
