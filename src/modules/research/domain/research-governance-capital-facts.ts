import governanceCapitalConfig from "../../../../config/research-governance-capital-facts.json";

export type GovernanceCapitalFactValueKind = "number" | "text";
export type GovernanceCapitalFactStatus = "verified" | "unavailable" | "conflicting";
export type GovernanceCapitalSourceAuthority = "issuer_disclosure" | "exchange_filing" | "regulator_or_court" | "audit_report";

type FactDefinition = { label: string; valueKind: GovernanceCapitalFactValueKind };
type FactMapping = { category: string; informationTypes: string[]; factKey: string; requiredFields: string[] };
const config = governanceCapitalConfig as { version: string; factDefinitions: Record<string, FactDefinition>; mappings: FactMapping[] };

export type ResearchGovernanceCapitalFactCandidate = {
  candidateId: string;
  securityCode: string;
  informationId: string;
  resultId: string;
  runId: string;
  versionId: string;
  contentHash: string;
  docId: string;
  entity: string;
  informationType: string;
  category: string;
  period: string | null;
  statement: string;
  factKey: string;
  requiredFields: string[];
  sourceUrl: string | null;
  contentUrl: string | null;
  title: string | null;
  sourceName: string | null;
  publishedAt: string | null;
  mappingConfigVersion: string;
  createdAt: number;
};

export type ResearchGovernanceCapitalFactCandidateReview = {
  candidateReviewId: string;
  candidateId: string;
  decision: "accepted" | "rejected" | "needs_evidence";
  reviewNote: string;
  reviewedBy: string;
  reviewedAt: number;
  createdAt: number;
};

export type ResearchGovernanceCapitalFactVersion = {
  governanceCapitalFactVersionId: string;
  candidateReviewId: string;
  supersedesFactVersionId: string | null;
  companyId: string;
  securityCode: string;
  factKey: string;
  factStatus: GovernanceCapitalFactStatus;
  valueKind: GovernanceCapitalFactValueKind;
  valueNumber: number | null;
  /** A disclosed interval is not collapsed to a midpoint or an endpoint. */
  valueRangeLower: number | null;
  valueRangeUpper: number | null;
  valueText: string | null;
  unit: string | null;
  asOf: string;
  period: string | null;
  sourceAuthority: GovernanceCapitalSourceAuthority;
  informationId: string;
  resultId: string;
  runId: string;
  versionId: string;
  contentHash: string;
  docId: string;
  sourceUrl: string | null;
  contentUrl: string | null;
  sourceTitle: string | null;
  sourceName: string | null;
  publishedAt: string | null;
  sourceLocator: string;
  createdAt: number;
};

export type GovernanceCapitalFactDefinition = FactDefinition & { factKey: string };

export function governanceCapitalFactConfigVersion(): string { return required(config.version, "governance/capital config version"); }
export function governanceCapitalFactDefinitions(): GovernanceCapitalFactDefinition[] {
  return Object.entries(config.factDefinitions).map(([factKey, definition]) => ({ factKey, label: required(definition.label, "fact definition label"), valueKind: definition.valueKind }));
}
export function governanceCapitalFactMappings(): FactMapping[] { return config.mappings.map((mapping) => ({ ...mapping, informationTypes: [...mapping.informationTypes], requiredFields: [...mapping.requiredFields] })); }

export function assertGovernanceCapitalCandidateReview(input: Pick<ResearchGovernanceCapitalFactCandidateReview, "decision" | "reviewNote" | "reviewedBy" | "reviewedAt">): void {
  if (!(["accepted", "rejected", "needs_evidence"] as const).includes(input.decision)) throw new Error("governance/capital candidate decision is invalid");
  required(input.reviewNote, "reviewNote"); required(input.reviewedBy, "reviewedBy");
  if (!Number.isInteger(input.reviewedAt) || input.reviewedAt <= 0) throw new Error("reviewedAt is invalid");
}

/** Validates the researcher-entered structured observation. Source data itself
 * is not accepted here; it is copied from the immutable review candidate. */
export function assertGovernanceCapitalFactVersion(input: Omit<ResearchGovernanceCapitalFactVersion, "createdAt" | "supersedesFactVersionId" | "candidateReviewId" | "companyId" | "securityCode" | "informationId" | "resultId" | "runId" | "versionId" | "contentHash" | "docId" | "sourceUrl" | "contentUrl" | "sourceTitle" | "sourceName" | "publishedAt" | "sourceLocator">): void {
  const definition = config.factDefinitions[input.factKey];
  if (!definition) throw new Error("governance/capital factKey is not configured");
  if (input.valueKind !== definition.valueKind) throw new Error("governance/capital valueKind does not match configured fact");
  if (!(["verified", "unavailable", "conflicting"] as const).includes(input.factStatus)) throw new Error("governance/capital factStatus is invalid");
  if (!(["issuer_disclosure", "exchange_filing", "regulator_or_court", "audit_report"] as const).includes(input.sourceAuthority)) throw new Error("governance/capital sourceAuthority is invalid");
  required(input.governanceCapitalFactVersionId, "governanceCapitalFactVersionId"); requiredDate(input.asOf, "asOf");
  const hasScalar = Number.isFinite(input.valueNumber) && input.valueNumber !== null;
  const hasRange = Number.isFinite(input.valueRangeLower) && input.valueRangeLower !== null
    && Number.isFinite(input.valueRangeUpper) && input.valueRangeUpper !== null;
  if (input.valueRangeLower !== null && input.valueRangeUpper !== null && input.valueRangeLower > input.valueRangeUpper) throw new Error("governance/capital numeric range lower bound must not exceed upper bound");
  if (input.valueKind === "number" && ((input.valueRangeLower === null) !== (input.valueRangeUpper === null) || (hasScalar && hasRange))) throw new Error("governance/capital numeric fact must use one scalar or one complete range");
  if (input.factStatus === "verified") {
    if (input.valueKind === "number" && ((!hasScalar && !hasRange) || !required(input.unit ?? "", "unit"))) throw new Error("verified numeric governance/capital fact requires a finite valueNumber or complete range and unit");
    if (input.valueKind === "text" && !required(input.valueText ?? "", "valueText")) throw new Error("verified text governance/capital fact requires valueText");
  }
  if (input.valueKind === "number" && input.valueText !== null) throw new Error("numeric governance/capital fact cannot carry valueText");
  if (input.valueKind === "text" && (input.valueNumber !== null || input.valueRangeLower !== null || input.valueRangeUpper !== null)) throw new Error("text governance/capital fact cannot carry numeric values");
}

export function governanceCapitalSourceLocator(candidate: Pick<ResearchGovernanceCapitalFactCandidate, "informationId" | "resultId" | "runId" | "versionId" | "contentHash" | "docId">): string {
  return `information_id=${candidate.informationId}; result_id=${candidate.resultId}; run_id=${candidate.runId}; version_id=${candidate.versionId}; document_id=${candidate.docId}; content_hash=${candidate.contentHash}`;
}

export function latestGovernanceCapitalFacts(facts: ResearchGovernanceCapitalFactVersion[]): ResearchGovernanceCapitalFactVersion[] {
  const byKey = new Map<string, ResearchGovernanceCapitalFactVersion>();
  for (const fact of [...facts].sort((left, right) => right.asOf.localeCompare(left.asOf) || right.createdAt - left.createdAt)) if (!byKey.has(fact.factKey)) byKey.set(fact.factKey, fact);
  return [...byKey.values()];
}

function required(value: string, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function requiredDate(value: string, label: string): void { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) throw new Error(`${label} must be YYYY-MM-DD`); }
