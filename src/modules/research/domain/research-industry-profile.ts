import { assertAsOf, assertSourceReferences, type ResearchEpistemicType, type ResearchSourceReference } from "./research-dossier";

export type ResearchVersionedStatus = "draft" | "reviewed" | "superseded";
export type ResearchIndustryAvailability = "available" | "empty" | "unavailable";
export type ResearchIndustryUnavailableReason = "storage_not_initialized" | "identity_not_found" | "no_records";

export type ResearchIndustrySection<T> = {
  availability: ResearchIndustryAvailability;
  reason: ResearchIndustryUnavailableReason | null;
  items: T[];
};

export type ResearchIndustryProfile = {
  industryProfileId: string;
  industryKey: string;
  taxonomy: string;
  taxonomyVersion: string;
  industryName: string;
  parentIndustryKey: string | null;
  asOf: number;
  version: number;
  status: ResearchVersionedStatus;
  definition: string;
  demandDrivers: unknown[];
  supplyStructure: Record<string, unknown>;
  cycleCharacteristics: Record<string, unknown>;
  valueChain: unknown[];
  epistemicType: Exclude<ResearchEpistemicType, "user_decision">;
  sourceReferences: ResearchSourceReference[];
  createdAt: number;
  updatedAt: number;
};

export type ResearchCompanyIndustryExposure = {
  exposureId: string;
  companyId: string;
  industryProfileId: string;
  asOf: number;
  version: number;
  status: ResearchVersionedStatus;
  selectionBasis: "primary_business";
  primaryBusinessDescription: string;
  exposureScope: Record<string, unknown>;
  exposureShare: Record<string, unknown>;
  epistemicType: Exclude<ResearchEpistemicType, "user_decision">;
  sourceReferences: ResearchSourceReference[];
  createdAt: number;
  updatedAt: number;
};

export type ResearchPeerComparisonPurpose = "operating_model" | "financial_quality" | "valuation_context" | "competitive_context";
export type ResearchPeerMembershipStatus = "included" | "excluded" | "watchlist";
export type ResearchPeerComparabilityStatus = "comparable" | "partially_comparable" | "not_comparable" | "unreviewed";

export type ResearchPeerUniverseMember = {
  peerMemberId: string;
  companyId: string | null;
  securityCode: string | null;
  peerName: string;
  relationshipType: "direct" | "adjacent" | "substitute" | "upstream" | "downstream" | "benchmark";
  membershipStatus: ResearchPeerMembershipStatus;
  comparabilityStatus: ResearchPeerComparabilityStatus;
  exclusionReason: string | null;
  comparisonDimensions: Record<string, unknown>;
  crossMarketMetadata: Record<string, unknown>;
  sourceReferences: ResearchSourceReference[];
  sortOrder: number;
};

export type ResearchPeerUniverse = {
  peerUniverseId: string;
  companyId: string;
  industryProfileId: string;
  asOf: number;
  version: number;
  status: ResearchVersionedStatus;
  comparisonPurpose: ResearchPeerComparisonPurpose;
  selectionCriteria: string;
  crossMarketPolicy: Record<string, unknown>;
  epistemicType: Exclude<ResearchEpistemicType, "user_decision">;
  sourceReferences: ResearchSourceReference[];
  members: ResearchPeerUniverseMember[];
  createdAt: number;
  updatedAt: number;
};

export function assertResearchIndustryRecord(input: {
  asOf: number;
  version: number;
  epistemicType: Exclude<ResearchEpistemicType, "user_decision">;
  sourceReferences: ResearchSourceReference[];
}, label: string): void {
  assertAsOf(input.asOf);
  if (!Number.isInteger(input.version) || input.version <= 0) throw new Error(`${label} version must be a positive integer`);
  // Industry classification, exposure and comparison are research inputs. Even
  // analyst-maintained records must point to the material used to make the mapping.
  if (!input.sourceReferences.length) throw new Error(`${label} requires at least one source reference`);
  assertSourceReferences(input.epistemicType, input.sourceReferences);
}

export function assertPeerMember(member: ResearchPeerUniverseMember): void {
  if (member.membershipStatus === "excluded" && !member.exclusionReason?.trim()) {
    throw new Error("excluded peer members require an exclusion reason");
  }
  if (!member.companyId && !member.securityCode && !member.peerName.trim()) {
    throw new Error("peer member requires an identifiable company, security, or name");
  }
  if (!member.sourceReferences.length) throw new Error("peer member requires at least one source reference");
  assertSourceReferences("observed_fact", member.sourceReferences);
}

export function availableIndustrySection<T>(items: T[]): ResearchIndustrySection<T> {
  return items.length
    ? { availability: "available", reason: null, items }
    : { availability: "empty", reason: "no_records", items: [] };
}

export function unavailableIndustrySection<T>(reason: Exclude<ResearchIndustryUnavailableReason, "no_records">): ResearchIndustrySection<T> {
  return { availability: "unavailable", reason, items: [] };
}
