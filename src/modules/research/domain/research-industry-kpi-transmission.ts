import transmissionConfig from "../../../../config/research-industry-kpi-transmission.json";
import { compileDriverPlanToSelfBuiltScenario, type DriverPlanValuationBridge, type ResearchOperatingDriverPlan } from "./research-operating-market";
import { projectOperatingScenarioForValuation, type OperatingScenarioValuationProjection } from "../application/operating-scenario-valuation";
import type { ResearchSourceReference } from "./research-dossier";

export type ResearchIndustryKpiTransmissionRule = {
  ruleId: string;
  source: { targetModule: "operating_driver"; targetField: string };
  destination: { subject: "operating_driver_segment_year"; field: "volume" | "pricePerUnit" };
  transformation: "identity";
  requiredMappingFields: string[];
};

export type ResearchIndustryKpiDriverBinding = {
  industryKpiDriverBindingId: string;
  securityCode: string;
  evidenceReferenceId: string;
  companyTrackExposureId: string;
  industryKpiId: string;
  industryKpiName: string;
  operatingDriverPlanId: string;
  operatingDriverSegmentYearId: string;
  transmissionRuleId: string;
  mappingConfigVersion: string;
  inputValue: number;
  inputUnit: string;
  mappingNote: string;
  mappedBy: string;
  mappedAt: number;
  createdAt: number;
  sourceReference: ResearchSourceReference;
};

export type IndustryKpiDriverBindingWrite = Omit<ResearchIndustryKpiDriverBinding, "industryKpiName" | "mappingConfigVersion" | "createdAt" | "sourceReference"> & { createdAt?: number };

export type IndustryKpiTransmissionCoverage = {
  operatingDriverSegmentYearId: string;
  field: "volume" | "pricePerUnit";
  state: "bound" | "plan_value" | "conflicted";
  bindingId: string | null;
  effectiveValue: number | null;
  reason: string | null;
};

export type IndustryKpiTransmissionProjection = {
  state: "ready" | "blocked";
  reason: string | null;
  effectiveDriverPlan: ResearchOperatingDriverPlan | null;
  coverage: IndustryKpiTransmissionCoverage[];
  valuationProjection: OperatingScenarioValuationProjection | null;
};

const config = transmissionConfig as { version: string; rules: ResearchIndustryKpiTransmissionRule[] };

export function researchIndustryKpiTransmissionConfigVersion(): string { return required(config.version, "industry KPI transmission config version"); }

/** Read-only configuration disclosure for local form choices.  Callers must
 * match a saved evidence candidate to this contract; they must not infer a
 * field or fabricate a rule id from a KPI name. */
export function researchIndustryKpiTransmissionRules(): ResearchIndustryKpiTransmissionRule[] {
  return config.rules.map((rule) => ({ ...rule, source: { ...rule.source }, destination: { ...rule.destination }, requiredMappingFields: [...rule.requiredMappingFields] }));
}

export function findResearchIndustryKpiTransmissionRule(ruleId: string): ResearchIndustryKpiTransmissionRule {
  const rule = config.rules.find((item) => item.ruleId === ruleId);
  if (!rule) throw new Error("industry KPI transmission rule is not configured");
  return rule;
}

export function assertResearchIndustryKpiDriverBinding(input: IndustryKpiDriverBindingWrite, candidateTarget: { targetModule: string; targetField: string }): void {
  [input.industryKpiDriverBindingId, input.securityCode, input.evidenceReferenceId, input.companyTrackExposureId, input.industryKpiId, input.operatingDriverPlanId, input.operatingDriverSegmentYearId, input.inputUnit, input.mappingNote, input.mappedBy].forEach((value) => required(value, "industry KPI binding field"));
  if (!Number.isFinite(input.inputValue)) throw new Error("industry KPI binding inputValue must be finite");
  if (!Number.isInteger(input.mappedAt) || input.mappedAt <= 0) throw new Error("industry KPI binding mappedAt is invalid");
  const rule = findResearchIndustryKpiTransmissionRule(input.transmissionRuleId);
  if (rule.transformation !== "identity") throw new Error("industry KPI transmission rule transformation is unsupported");
  if (rule.source.targetModule !== candidateTarget.targetModule || rule.source.targetField !== candidateTarget.targetField) {
    throw new Error("industry KPI binding rule does not match the accepted evidence target");
  }
  if (rule.destination.field === "volume" && input.inputValue < 0) throw new Error("industry KPI volume input must be non-negative");
}

/**
 * Applies only explicit, persisted direct bindings.  There is no text parsing,
 * unit conversion or scenario inference: a missing binding keeps the saved
 * plan value visible, while competing bindings block the projection outright.
 */
export function projectIndustryKpiDriverTransmission(
  plan: ResearchOperatingDriverPlan,
  bindings: ResearchIndustryKpiDriverBinding[],
  valuation: DriverPlanValuationBridge,
): IndustryKpiTransmissionProjection {
  const targetIds = new Set(plan.years.flatMap((year) => year.segments.map((segment) => segment.operatingDriverSegmentYearId)));
  const coverage: IndustryKpiTransmissionCoverage[] = [];
  const byTarget = new Map<string, ResearchIndustryKpiDriverBinding[]>();
  for (const binding of bindings) {
    if (binding.operatingDriverPlanId !== plan.operatingDriverPlanId) throw new Error("industry KPI binding does not belong to driver plan");
    if (!targetIds.has(binding.operatingDriverSegmentYearId)) throw new Error("industry KPI binding does not belong to driver plan segment");
    const rule = findResearchIndustryKpiTransmissionRule(binding.transmissionRuleId);
    const target = `${binding.operatingDriverSegmentYearId}:${rule.destination.field}`;
    const items = byTarget.get(target) ?? [];
    items.push(binding); byTarget.set(target, items);
  }
  const effectivePlan: ResearchOperatingDriverPlan = {
    ...plan,
    years: plan.years.map((year) => ({ ...year, segments: year.segments.map((segment) => {
      const replace = (field: "volume" | "pricePerUnit") => {
        const items = byTarget.get(`${segment.operatingDriverSegmentYearId}:${field}`) ?? [];
        if (items.length > 1) { coverage.push({ operatingDriverSegmentYearId: segment.operatingDriverSegmentYearId, field, state: "conflicted", bindingId: null, effectiveValue: null, reason: "more than one immutable binding targets this driver field" }); return null; }
        if (items.length === 1) { coverage.push({ operatingDriverSegmentYearId: segment.operatingDriverSegmentYearId, field, state: "bound", bindingId: items[0].industryKpiDriverBindingId, effectiveValue: items[0].inputValue, reason: null }); return items[0].inputValue; }
        coverage.push({ operatingDriverSegmentYearId: segment.operatingDriverSegmentYearId, field, state: "plan_value", bindingId: null, effectiveValue: segment[field], reason: "no accepted industry KPI binding; uses this version's explicit driver value" }); return segment[field];
      };
      const volume = replace("volume"); const pricePerUnit = replace("pricePerUnit");
      return { ...segment, volume: volume ?? segment.volume, pricePerUnit: pricePerUnit ?? segment.pricePerUnit };
    }) })),
  };
  if (coverage.some((item) => item.state === "conflicted")) return { state: "blocked", reason: "conflicting immutable industry KPI bindings require a new driver-plan version", effectiveDriverPlan: null, coverage, valuationProjection: null };
  return { state: "ready", reason: null, effectiveDriverPlan: effectivePlan, coverage, valuationProjection: projectOperatingScenarioForValuation(compileDriverPlanToSelfBuiltScenario(effectivePlan, valuation)) };
}

function required(value: string, label: string): string { const text = String(value ?? "").trim(); if (!text) throw new Error(`${label} is required`); return text; }
