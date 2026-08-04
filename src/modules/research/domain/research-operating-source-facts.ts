import operatingSourceFactConfig from "../../../../config/research-operating-source-facts.json";
import type { ResearchInformationEvidenceTargetModule } from "./research-information-evidence";
import { assertAsOf } from "./research-dossier";

export type ResearchOperatingSourceFactKind =
  | "segment_volume" | "unit_price" | "capacity_utilization" | "order_backlog"
  | "contract_commitment" | "customer_relationship" | "capacity_constraint" | "growth_constraint"
  | "product_offering" | "segment_scope" | "revenue_recognition" | "unit_economics";
export type ResearchOperatingSourceFactPeriodKind = "historical" | "current" | "future_guidance" | "event" | "other";

export type ResearchOperatingSourceFact = {
  operatingSourceFactId: string;
  operatingCompanyId: string;
  sourceSecurityCode: string;
  evidenceReferenceId: string;
  candidateId: string;
  candidateReviewId: string;
  targetModule: ResearchInformationEvidenceTargetModule;
  targetField: string;
  factKind: ResearchOperatingSourceFactKind;
  subjectLabel: string;
  segmentLabel: string | null;
  customerOrChannel: string | null;
  periodLabel: string;
  periodKind: ResearchOperatingSourceFactPeriodKind;
  reportedValue: string;
  numericValue: number | null;
  unit: string | null;
  currency: string | null;
  amountScale: string | null;
  scopeDescription: string;
  comparabilityNote: string;
  statement: string;
  informationType: string;
  mappingConfigVersion: string;
  recordedBy: string;
  recordedAt: number;
  createdAt: number;
};

type Mapping = {
  targetModule: ResearchInformationEvidenceTargetModule;
  targetField: string;
  factKinds: ResearchOperatingSourceFactKind[];
  requiresNumericValue: boolean;
  requiresUnit: boolean;
  requiresCurrency?: boolean;
  requiresCustomerOrChannel?: boolean;
};
const config = operatingSourceFactConfig as { version: string; mappings: Mapping[] };

export function operatingSourceFactConfigVersion(): string { return config.version; }
export function operatingSourceFactMapping(targetModule: ResearchInformationEvidenceTargetModule, targetField: string): Mapping | null {
  return config.mappings.find((item) => item.targetModule === targetModule && item.targetField === targetField) ?? null;
}

/** Source facts are immutable observations.  They do not contain an analysis/model identifier. */
export function assertResearchOperatingSourceFact(input: ResearchOperatingSourceFact): void {
  for (const [label, value] of Object.entries({ operatingSourceFactId: input.operatingSourceFactId, operatingCompanyId: input.operatingCompanyId, sourceSecurityCode: input.sourceSecurityCode, evidenceReferenceId: input.evidenceReferenceId, candidateId: input.candidateId, candidateReviewId: input.candidateReviewId, subjectLabel: input.subjectLabel, periodLabel: input.periodLabel, reportedValue: input.reportedValue, scopeDescription: input.scopeDescription, comparabilityNote: input.comparabilityNote, statement: input.statement, informationType: input.informationType, recordedBy: input.recordedBy })) required(value, label);
  if (!( ["historical", "current", "future_guidance", "event", "other"] as const).includes(input.periodKind)) throw new Error("operating source fact periodKind is invalid");
  if (!(["fact", "guidance", "forecast", "opinion", "event", "relationship"] as const).includes(input.informationType as any)) throw new Error("operating source fact informationType is invalid");
  if (input.numericValue !== null && !Number.isFinite(input.numericValue)) throw new Error("operating source fact numericValue must be finite when supplied");
  assertAsOf(input.recordedAt); assertAsOf(input.createdAt);
  const mapping = operatingSourceFactMapping(input.targetModule, input.targetField);
  if (!mapping) throw new Error("evidence target is not approved for an operating source fact");
  if (!mapping.factKinds.includes(input.factKind)) throw new Error("operating source fact kind is incompatible with accepted evidence target");
  if (mapping.requiresNumericValue && input.numericValue === null) throw new Error("operating source fact requires a normalized numeric value");
  if (mapping.requiresUnit && !input.unit?.trim()) throw new Error("operating source fact requires a unit");
  if (mapping.requiresCurrency && !input.currency?.trim()) throw new Error("operating source fact requires a currency");
  if (mapping.requiresCustomerOrChannel && !input.customerOrChannel?.trim()) throw new Error("operating source fact requires a customer or channel");
}

function required(value: unknown, label: string): void { if (!String(value ?? "").trim()) throw new Error(`${label} is required`); }
