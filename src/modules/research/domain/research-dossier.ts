export type ResearchEpistemicType =
  | "observed_fact"
  | "management_guidance"
  | "source_viewpoint"
  | "third_party_forecast"
  | "analysis_assumption"
  | "system_judgment"
  | "user_decision";

export type ResearchSourceReference = {
  sourceKind: "knowledge_record" | "knowledge_document" | "filing" | "market_data" | "external_url" | "dossier_record" | "research_record";
  sourceId?: string;
  informationId?: string;
  versionId?: string;
  documentId?: string;
  url?: string;
  title?: string;
  publishedAt?: string | number;
  locator?: string;
};

export type ResearchDossierAvailability = "available" | "empty" | "unavailable";
export type ResearchDossierUnavailableReason =
  | "storage_not_initialized"
  | "identity_not_found"
  | "owner_required";

export type ResearchDossierSection<T> = {
  availability: ResearchDossierAvailability;
  reason: ResearchDossierUnavailableReason | "no_records" | null;
  items: T[];
};

export type ResearchOperatingCompanyIdentity = {
  companyId: string;
  canonicalName: string;
  reportingCurrency: string | null;
  fiscalYearEnd: string | null;
  identityStatus: "confirmed" | "provisional" | "needs_review";
};

export type ResearchListedSecurityIdentity = {
  securityCode: string;
  companyId: string | null;
  venue: string;
  tradingCurrency: string | null;
  shareClass: string | null;
  depositaryRatio: number | null;
  mappingStatus: "confirmed" | "provisional" | "unresolved" | "conflicting";
  mappingBasis: string | null;
};

export type ResearchBusinessSegment = {
  segmentId: string;
  name: string;
  revenueDriver: string | null;
  customerScope: string | null;
  geographicScope: string | null;
  pricingModel: string | null;
  costDriver: string | null;
  workingCapitalDriver: string | null;
  capitalIntensityDriver: string | null;
  sourceReferences: ResearchSourceReference[];
  sortOrder: number;
};

export type ResearchBusinessModel = {
  businessModelId: string;
  companyId: string;
  asOf: number;
  status: "draft" | "reviewed" | "superseded";
  primaryEarningDriver: string | null;
  revenueRecognition: string | null;
  summary: string;
  epistemicType: ResearchEpistemicType;
  sourceReferences: ResearchSourceReference[];
  segments: ResearchBusinessSegment[];
  createdAt: number;
  updatedAt: number;
};

export type ResearchMarketSpaceModel = {
  marketSpaceId: string;
  companyId: string;
  asOf: number;
  status: "draft" | "reviewed" | "superseded";
  marketDefinition: string;
  tam: Record<string, unknown>;
  sam: Record<string, unknown>;
  som: Record<string, unknown>;
  profitPool: Record<string, unknown>;
  topDown: Record<string, unknown>;
  bottomUp: Record<string, unknown>;
  transmission: Record<string, unknown>;
  epistemicType: ResearchEpistemicType;
  sourceReferences: ResearchSourceReference[];
  createdAt: number;
  updatedAt: number;
};

export type ResearchCompetitor = {
  competitorId: string;
  name: string;
  securityCode: string | null;
  competitorType: "direct" | "adjacent" | "substitute" | "new_entrant" | "customer_inhouse" | "supplier_forward";
  comparabilityNote: string;
  metrics: Record<string, unknown>;
  sourceReferences: ResearchSourceReference[];
};

export type ResearchCompetitiveMarket = {
  competitiveMarketId: string;
  companyId: string;
  asOf: number;
  status: "draft" | "reviewed" | "superseded";
  definition: string;
  productScope: string | null;
  customerScope: string | null;
  geographyScope: string | null;
  periodScope: string | null;
  structure: Record<string, unknown>;
  advantages: unknown[];
  erosionPaths: unknown[];
  epistemicType: ResearchEpistemicType;
  sourceReferences: ResearchSourceReference[];
  competitors: ResearchCompetitor[];
  createdAt: number;
  updatedAt: number;
};

export type ResearchThesisEvidence = {
  thesisEvidenceId: string;
  thesisId: string;
  stance: "support" | "contradict" | "conflict" | "context";
  knowledgeInformationId: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  epistemicType: ResearchEpistemicType;
  statement: string;
  applicablePeriod: string | null;
  observedAt: number | null;
  sourceReferences: ResearchSourceReference[];
  createdAt: number;
};

export type ResearchThesis = {
  thesisId: string;
  companyId: string;
  asOf: number;
  title: string;
  statement: string;
  status: "active" | "under_review" | "invalidated" | "superseded";
  epistemicType: "system_judgment" | "user_decision";
  invalidationCondition: string;
  reviewBy: number | null;
  evidence: ResearchThesisEvidence[];
  createdAt: number;
  updatedAt: number;
};

export type ResearchTypedValue = {
  epistemicType: ResearchEpistemicType;
  value: unknown;
  label?: string;
  sourceReferences?: ResearchSourceReference[];
};

export type ResearchValuationCase = {
  valuationCaseId: string;
  securityCode: string;
  companyId: string | null;
  asOf: number;
  status: "draft" | "reviewed" | "superseded";
  valuationType: "dcf" | "relative" | "asset" | "dividend" | "sum_of_parts" | "reverse" | "other";
  methodRationale: string;
  assumptions: ResearchTypedValue[];
  result: ResearchTypedValue;
  sensitivity: ResearchTypedValue[];
  sourceReferences: ResearchSourceReference[];
  createdAt: number;
  updatedAt: number;
};

export type ResearchRiskEntry = {
  riskId: string;
  companyId: string | null;
  securityCode: string | null;
  asOf: number;
  category: string;
  // Public research records must never carry a user's portfolio state.  Personal
  // decisions live in owner-scoped research_user_notes and can only reference
  // this public evidence; they cannot become a public risk input.
  scope: "operating_company" | "listed_security";
  title: string;
  exposure: string;
  transmission: string;
  lossRange: string | null;
  likelihood: string | null;
  impact: string | null;
  speed: string | null;
  reversibility: string | null;
  grossRisk: string | null;
  verifiedMitigation: string | null;
  residualRisk: string | null;
  triggerCondition: string;
  reviewFrequency: string | null;
  status: "new" | "active" | "upgraded" | "downgraded" | "resolved" | "unavailable";
  epistemicType: "system_judgment";
  sourceReferences: ResearchSourceReference[];
  createdAt: number;
  updatedAt: number;
};

export type ResearchCatalyst = {
  catalystId: string;
  companyId: string | null;
  securityCode: string | null;
  eventAt: number | null;
  eventType: string;
  title: string;
  status: "occurred" | "guided" | "external_expectation" | "tentative" | "cancelled";
  impactedAssumption: string;
  expectedEffect: string | null;
  outcomeNote: string | null;
  /** Later observed outcomes are append-only and do not alter this event record. */
  reviews: import("./research-catalyst-review").ResearchCatalystReview[];
  epistemicType: ResearchEpistemicType;
  sourceReferences: ResearchSourceReference[];
  createdAt: number;
  updatedAt: number;
};

export type ResearchAnalysisSnapshot = {
  analysisSnapshotId: string;
  companyId: string | null;
  securityCode: string;
  asOf: number;
  completionLevel: "basic" | "standard" | "deep";
  state: string;
  summary: Record<string, unknown>;
  moduleStatus: Record<string, unknown>;
  epistemicType: "system_judgment";
  createdAt: number;
};

export type ResearchUserNote = {
  noteId: string;
  ownerKey: string;
  companyId: string | null;
  securityCode: string;
  noteType: "watch_reason" | "personal_view" | "question" | "decision_reference";
  content: string;
  epistemicType: "user_decision";
  sourceReferences: ResearchSourceReference[];
  createdAt: number;
  updatedAt: number;
};

export type ResearchDossier = {
  securityCode: string;
  companyId: string | null;
  asOf: number;
  availability: "available" | "unavailable";
  unavailableReason: ResearchDossierUnavailableReason | null;
  operatingCompany: ResearchOperatingCompanyIdentity | null;
  listedSecurity: ResearchListedSecurityIdentity | null;
  businessModels: ResearchDossierSection<ResearchBusinessModel>;
  marketSpaceModels: ResearchDossierSection<ResearchMarketSpaceModel>;
  competitiveMarkets: ResearchDossierSection<ResearchCompetitiveMarket>;
  theses: ResearchDossierSection<ResearchThesis>;
  valuationCases: ResearchDossierSection<ResearchValuationCase>;
  risks: ResearchDossierSection<ResearchRiskEntry>;
  catalysts: ResearchDossierSection<ResearchCatalyst>;
  snapshots: ResearchDossierSection<ResearchAnalysisSnapshot>;
  userNotes: ResearchDossierSection<ResearchUserNote>;
};

export function availableSection<T>(items: T[]): ResearchDossierSection<T> {
  return items.length > 0
    ? { availability: "available", reason: null, items }
    : { availability: "empty", reason: "no_records", items: [] };
}

export function unavailableSection<T>(reason: ResearchDossierUnavailableReason): ResearchDossierSection<T> {
  return { availability: "unavailable", reason, items: [] };
}

export function unavailableResearchDossier(
  securityCode: string,
  asOf: number,
  reason: ResearchDossierUnavailableReason,
): ResearchDossier {
  return {
    securityCode,
    companyId: null,
    asOf,
    availability: "unavailable",
    unavailableReason: reason,
    operatingCompany: null,
    listedSecurity: null,
    businessModels: unavailableSection(reason),
    marketSpaceModels: unavailableSection(reason),
    competitiveMarkets: unavailableSection(reason),
    theses: unavailableSection(reason),
    valuationCases: unavailableSection(reason),
    risks: unavailableSection(reason),
    catalysts: unavailableSection(reason),
    snapshots: unavailableSection(reason),
    userNotes: unavailableSection(reason),
  };
}

export function epistemicTypeFromSourceType(value: string): ResearchEpistemicType {
  const mapping: Record<string, ResearchEpistemicType> = {
    fact: "observed_fact",
    management_guidance: "management_guidance",
    third_party_view: "source_viewpoint",
    third_party_forecast: "third_party_forecast",
    source_viewpoint: "source_viewpoint",
    analyst_assumption: "analysis_assumption",
    system_assessment: "system_judgment",
    user_decision: "user_decision",
  };
  const result = mapping[value];
  if (!result) throw new Error(`unsupported research epistemic type: ${value}`);
  return result;
}

export function epistemicTypeForCatalystStatus(status: ResearchCatalyst["status"]): ResearchEpistemicType {
  if (status === "occurred" || status === "cancelled") return "observed_fact";
  if (status === "guided") return "management_guidance";
  if (status === "external_expectation") return "third_party_forecast";
  return "analysis_assumption";
}

export function assertSourceReferences(
  epistemicType: ResearchEpistemicType,
  references: ResearchSourceReference[],
): void {
  if (["observed_fact", "management_guidance", "source_viewpoint", "third_party_forecast"].includes(epistemicType)
    && references.length === 0) {
    throw new Error(`${epistemicType} requires at least one source reference`);
  }
  for (const reference of references) {
    if (!reference.sourceKind || !(reference.sourceId || reference.informationId || reference.documentId || reference.url)) {
      throw new Error("research source reference requires a kind and resolvable identifier");
    }
  }
}

export function assertAsOf(value: number): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error("research dossier asOf must be a positive integer");
}
