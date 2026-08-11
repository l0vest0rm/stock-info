import analysisTemplateRegistry from "../../../../config/research-analysis-template-registry.json";

type Row = Record<string, unknown>;
export type ResearchIndustryTemplateOption = {
  templateId: string;
  industryKey: string;
  label: string;
  frameworkCategory: string;
  presentationCategoryId: string;
  presentationCategoryLabel: string;
  operatingFeatureLabel: string;
  legacyTemplateIds: string[];
};
export type ResearchAnalysisPresentationCategory = { id: string; label: string };
export type ResearchOperatingAnalysisRoutingConfirmation = {
  confirmationId: string;
  securityCode: string;
  companyId: string | null;
  actorKey: string;
  routingStateBefore: "unconfirmed" | "confirmed";
  routingStateAfter: "confirmed";
  selectedTemplateId: string;
  scopeNote: string | null;
  companyScope: Record<string, unknown>;
  candidateTemplates: unknown[];
  sourceArtifactId: string | null;
  createdAt: number;
};

export type ResearchOperatingAnalysisRoutingReadModel = {
  availability: "available" | "empty" | "unavailable";
  presentationCategories: ResearchAnalysisPresentationCategory[];
  templates: ResearchIndustryTemplateOption[];
  current: {
    state: "unconfirmed" | "confirmed";
    selectedTemplateId: string | null;
    scopeNote: string | null;
    companyScope: Record<string, unknown>;
    candidateTemplates: unknown[];
    reasons: unknown[];
  };
  manualConfirmation: ResearchOperatingAnalysisRoutingConfirmation | null;
  history: ResearchOperatingAnalysisRoutingConfirmation[];
};

export function registeredResearchIndustryTemplateIds(): string[] {
  return analysisTemplateRegistry.templates.map((template) => String(template.templateId));
}

export function registeredResearchIndustryTemplates(): ResearchIndustryTemplateOption[] {
  const aliases = analysisTemplateRegistry.templateAliases as Record<string, string>;
  const presentations = analysisTemplateRegistry.templatePresentation as Record<string, { categoryId?: string; featureLabel?: string }>;
  const categories = new Map(registeredResearchAnalysisPresentationCategories().map((category) => [category.id, category.label]));
  return analysisTemplateRegistry.templates.map((template) => ({
    templateId: String(template.templateId),
    industryKey: String(template.industryKey),
    label: String(template.label),
    frameworkCategory: String(template.frameworkCategory),
    presentationCategoryId: String(presentations[String(template.templateId)]?.categoryId || ""),
    presentationCategoryLabel: String(categories.get(String(presentations[String(template.templateId)]?.categoryId || "")) || ""),
    operatingFeatureLabel: String(presentations[String(template.templateId)]?.featureLabel || ""),
    legacyTemplateIds: Object.entries(aliases).filter(([, canonical]) => canonical === template.templateId).map(([legacy]) => legacy),
  }));
}

export function registeredResearchAnalysisPresentationCategories(): ResearchAnalysisPresentationCategory[] {
  return (analysisTemplateRegistry.presentationCategories || []).map((category) => ({ id: String(category.id), label: String(category.label) }));
}

export function isRegisteredResearchIndustryTemplate(templateId: unknown): boolean {
  const normalized = typeof templateId === "string" ? templateId.trim() : "";
  const canonical = (analysisTemplateRegistry.templateAliases as Record<string, string>)[normalized] ?? normalized;
  return Boolean(canonical && analysisTemplateRegistry.templates.some((template) => template.templateId === canonical));
}

export async function loadResearchOperatingAnalysisRouting(db: D1Database, securityCode: string): Promise<ResearchOperatingAnalysisRoutingReadModel> {
  try {
    const rows = await db.prepare(`select confirmation_id, security_code, company_id, actor_key, routing_state_before,
      routing_state_after, selected_template_id, scope_note, company_scope_json, candidate_templates_json,
      source_artifact_id, created_at
      from research_operating_analysis_routing_confirmations
      where security_code=? order by created_at desc, confirmation_id desc`).bind(securityCode).all<Row>();
    const history = rows.results.map(mapConfirmation);
    const latest = history[0] ?? null;
    return {
      availability: history.length ? "available" : "empty", presentationCategories: registeredResearchAnalysisPresentationCategories(),
      templates: registeredResearchIndustryTemplates(),
      current: latest ? { state: latest.routingStateAfter, selectedTemplateId: latest.selectedTemplateId, scopeNote: latest.scopeNote, companyScope: latest.companyScope, candidateTemplates: latest.candidateTemplates, reasons: [{ code: "manual_confirmation", message: latest.scopeNote || `人工确认模板 ${latest.selectedTemplateId}` }] } : { state: "unconfirmed", selectedTemplateId: null, scopeNote: null, companyScope: {}, candidateTemplates: [], reasons: [{ code: "awaiting_local_routing", message: "尚未产生本地受控模板匹配或人工确认" }] },
      manualConfirmation: latest,
      history,
    };
  } catch (error) {
    if (/no such table/i.test(String(error))) return { availability: "unavailable", presentationCategories: registeredResearchAnalysisPresentationCategories(), templates: registeredResearchIndustryTemplates(), current: { state: "unconfirmed", selectedTemplateId: null, scopeNote: null, companyScope: {}, candidateTemplates: [], reasons: [{ code: "routing_storage_unavailable", message: "路由确认审计表尚未初始化" }] }, manualConfirmation: null, history: [] };
    throw error;
  }
}

export async function recordResearchOperatingAnalysisRoutingConfirmation(db: D1Database, input: {
  confirmationId: string;
  securityCode: string;
  companyId: string | null;
  actorKey: string;
  routingStateBefore: "unconfirmed" | "confirmed";
  selectedTemplateId: string;
  scopeNote: string | null;
  companyScope: Record<string, unknown>;
  candidateTemplates: unknown[];
  sourceArtifactId: string | null;
  createdAt: number;
}): Promise<ResearchOperatingAnalysisRoutingConfirmation> {
  const selectedTemplateId = input.selectedTemplateId.trim();
  if (!isRegisteredResearchIndustryTemplate(selectedTemplateId)) throw new Error(`unregistered research analysis template: ${selectedTemplateId || "(empty)"}`);
  const scopeNote = input.scopeNote?.trim() || null;
  if (scopeNote && scopeNote.length > 4000) throw new Error("routing scopeNote must be at most 4000 characters");
  const record: ResearchOperatingAnalysisRoutingConfirmation = { ...input, selectedTemplateId, routingStateAfter: "confirmed", scopeNote, companyScope: input.companyScope ?? {}, candidateTemplates: Array.isArray(input.candidateTemplates) ? input.candidateTemplates : [], sourceArtifactId: input.sourceArtifactId || null };
  await db.prepare(`insert into research_operating_analysis_routing_confirmations (
    confirmation_id, security_code, company_id, actor_key, routing_state_before, routing_state_after,
    selected_template_id, scope_note, company_scope_json, candidate_templates_json, source_artifact_id, created_at
  ) values (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?)`)
    .bind(record.confirmationId, record.securityCode, record.companyId, record.actorKey, record.routingStateBefore, record.selectedTemplateId, record.scopeNote, JSON.stringify(record.companyScope), JSON.stringify(record.candidateTemplates), record.sourceArtifactId, record.createdAt).run();
  return record;
}

function mapConfirmation(row: Row): ResearchOperatingAnalysisRoutingConfirmation {
  const stateBefore = String(row.routing_state_before ?? "unconfirmed");
  return {
    confirmationId: String(row.confirmation_id ?? ""), securityCode: String(row.security_code ?? ""), companyId: row.company_id ? String(row.company_id) : null,
    actorKey: String(row.actor_key ?? "local-user"), routingStateBefore: stateBefore === "confirmed" ? "confirmed" : "unconfirmed", routingStateAfter: "confirmed",
    selectedTemplateId: String(row.selected_template_id ?? ""), scopeNote: row.scope_note ? String(row.scope_note) : null,
    companyScope: parseObject(row.company_scope_json), candidateTemplates: parseArray(row.candidate_templates_json), sourceArtifactId: row.source_artifact_id ? String(row.source_artifact_id) : null, createdAt: Number(row.created_at) || 0,
  };
}

function parseObject(value: unknown): Record<string, unknown> { try { const parsed = JSON.parse(String(value ?? "{}")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function parseArray(value: unknown): unknown[] { try { const parsed = JSON.parse(String(value ?? "[]")); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
