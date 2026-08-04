import { assertAsOf, assertSourceReferences, type ResearchEpistemicType, type ResearchSourceReference } from "./research-dossier";

export type ResearchTrackStatus = "draft" | "reviewed" | "superseded";
export type ResearchIndustryAvailability = "available" | "empty" | "unavailable";
export type ResearchIndustryUnavailableReason = "storage_not_initialized" | "identity_not_found" | "no_records";
export type ResearchIndustrySection<T> = { availability: ResearchIndustryAvailability; reason: ResearchIndustryUnavailableReason | null; items: T[] };
export type ResearchPublicEpistemicType = Exclude<ResearchEpistemicType, "user_decision">;

export type ResearchIndustryDemandDriver = {
  driverId: string;
  driverKind: "volume" | "price" | "penetration" | "utilization" | "asset_growth" | "customer_capex" | "policy" | "other";
  label: string;
  definition: string;
  indicatorName: string | null;
  indicatorFrequency: string | null;
  leadingLagging: "leading" | "coincident" | "lagging" | "not_assessed";
  financialTransmission: string;
  sortOrder: number;
  sourceReferences: ResearchSourceReference[];
};

export type ResearchIndustrySupplyConstraint = {
  constraintId: string;
  constraintKind: "capacity" | "resource" | "technology" | "regulation" | "yield" | "capital" | "labor" | "other";
  label: string;
  description: string;
  affectedVariable: string;
  directionWhenBinding: "raises_price" | "limits_volume" | "raises_cost" | "delays_delivery" | "mixed" | "not_assessed";
  sortOrder: number;
  sourceReferences: ResearchSourceReference[];
};

export type ResearchIndustryValueChainNode = {
  valueChainNodeId: string;
  nodeRole: "input_supplier" | "component_supplier" | "producer" | "channel" | "customer" | "payer" | "regulator" | "other";
  name: string;
  description: string;
  revenueRecognitionRole: string;
  sortOrder: number;
  sourceReferences: ResearchSourceReference[];
};

export type ResearchIndustryKpi = {
  kpiId: string;
  name: string;
  definition: string;
  unit: string;
  frequency: string;
  timingRole: "leading" | "coincident" | "lagging" | "not_assessed";
  financialMapping: string;
  sortOrder: number;
  sourceReferences: ResearchSourceReference[];
};

export type ResearchIndustryTrackProfile = {
  trackProfileId: string;
  industryKey: string;
  taxonomy: string;
  taxonomyVersion: string;
  industryName: string;
  parentIndustryKey: string | null;
  asOf: number;
  version: number;
  status: ResearchTrackStatus;
  boundaryIncluded: string;
  boundaryExcluded: string;
  demandEquation: string | null;
  supplyEquation: string | null;
  cyclePosition: "not_assessed" | "trough" | "recovery" | "expansion" | "peak" | "contraction" | "structurally_non_cyclical";
  valuationPrimaryMethod: string | null;
  valuationLimitations: string | null;
  epistemicType: ResearchPublicEpistemicType;
  sourceReferences: ResearchSourceReference[];
  demandDrivers: ResearchIndustryDemandDriver[];
  supplyConstraints: ResearchIndustrySupplyConstraint[];
  valueChainNodes: ResearchIndustryValueChainNode[];
  kpis: ResearchIndustryKpi[];
  createdAt: number;
  updatedAt: number;
};

export type ResearchCompanyTrackExposureShare = {
  exposureShareId: string;
  measure: "revenue" | "gross_profit" | "operating_profit" | "assets" | "volume" | "other";
  value: number;
  unit: "ratio" | "percent" | "currency" | "units";
  basisPeriod: string;
  denominatorDescription: string | null;
  sortOrder: number;
  sourceReferences: ResearchSourceReference[];
};

export type ResearchCompanyTrackExposure = {
  companyTrackExposureId: string;
  companyId: string;
  trackProfileId: string;
  asOf: number;
  version: number;
  status: ResearchTrackStatus;
  selectionBasis: "primary_business" | "secondary_business";
  businessSegment: string;
  productScope: string;
  geographicScope: string;
  customerScope: string;
  exposureDescription: string;
  epistemicType: ResearchPublicEpistemicType;
  sourceReferences: ResearchSourceReference[];
  shares: ResearchCompanyTrackExposureShare[];
  createdAt: number;
  updatedAt: number;
};

export type ResearchPeerComparisonDimension = {
  comparisonDimensionId: string;
  dimension: "business_model" | "product_scope" | "customer_scope" | "geography" | "reporting_currency" | "accounting_basis" | "fiscal_year" | "capital_intensity" | "cycle_position" | "security_rights";
  status: "aligned" | "adjustment_required" | "not_comparable" | "not_assessed";
  targetValue: string | null;
  peerValue: string | null;
  adjustmentNote: string | null;
  sortOrder: number;
  sourceReferences: ResearchSourceReference[];
};

export type ResearchPeerComparisonMember = {
  peerComparisonMemberId: string;
  companyId: string | null;
  securityCode: string | null;
  peerName: string;
  relationshipType: "direct" | "adjacent" | "substitute" | "upstream" | "downstream" | "benchmark";
  membershipStatus: "included" | "excluded" | "watchlist";
  comparabilityStatus: "comparable" | "partially_comparable" | "not_comparable" | "unreviewed";
  exclusionReason: string | null;
  sortOrder: number;
  sourceReferences: ResearchSourceReference[];
  dimensions: ResearchPeerComparisonDimension[];
};

export type ResearchPeerComparisonSet = {
  peerComparisonSetId: string;
  companyId: string;
  trackProfileId: string;
  asOf: number;
  version: number;
  status: ResearchTrackStatus;
  comparisonPurpose: "operating_model" | "financial_quality" | "valuation_context" | "competitive_context";
  selectionCriteria: string;
  epistemicType: ResearchPublicEpistemicType;
  sourceReferences: ResearchSourceReference[];
  members: ResearchPeerComparisonMember[];
  createdAt: number;
  updatedAt: number;
};

export function assertResearchIndustryTrackProfile(input: ResearchIndustryTrackProfile): void {
  assertVersionedEvidence(input, "industry track profile");
  required(input.trackProfileId, "trackProfileId"); required(input.industryKey, "industryKey"); required(input.taxonomy, "taxonomy");
  required(input.taxonomyVersion, "taxonomyVersion"); required(input.industryName, "industryName");
  required(input.boundaryIncluded, "boundaryIncluded"); required(input.boundaryExcluded, "boundaryExcluded");
  for (const driver of input.demandDrivers) assertDemandDriver(driver);
  for (const constraint of input.supplyConstraints) assertSupplyConstraint(constraint);
  for (const node of input.valueChainNodes) assertValueChainNode(node);
  for (const kpi of input.kpis) assertKpi(kpi);
}

export function assertResearchCompanyTrackExposure(input: ResearchCompanyTrackExposure): void {
  assertVersionedEvidence(input, "company track exposure");
  required(input.companyTrackExposureId, "companyTrackExposureId"); required(input.companyId, "companyId"); required(input.trackProfileId, "trackProfileId");
  required(input.businessSegment, "businessSegment"); required(input.productScope, "productScope"); required(input.geographicScope, "geographicScope");
  required(input.customerScope, "customerScope"); required(input.exposureDescription, "exposureDescription");
  for (const share of input.shares) {
    required(share.exposureShareId, "exposureShareId"); required(share.basisPeriod, "basisPeriod");
    if (!Number.isFinite(share.value) || share.value < 0) throw new Error("exposure share value must be a non-negative finite number");
    assertRequiredEvidence(share.sourceReferences, "exposure share");
  }
}

export function assertResearchPeerComparisonSet(input: ResearchPeerComparisonSet): void {
  assertVersionedEvidence(input, "peer comparison set");
  required(input.peerComparisonSetId, "peerComparisonSetId"); required(input.companyId, "companyId"); required(input.trackProfileId, "trackProfileId"); required(input.selectionCriteria, "selectionCriteria");
  for (const member of input.members) assertPeerMember(member);
}

function assertDemandDriver(item: ResearchIndustryDemandDriver): void {
  required(item.driverId, "driverId"); required(item.label, "demand driver label"); required(item.definition, "demand driver definition"); required(item.financialTransmission, "demand driver financialTransmission"); assertRequiredEvidence(item.sourceReferences, "demand driver");
}
function assertSupplyConstraint(item: ResearchIndustrySupplyConstraint): void {
  required(item.constraintId, "constraintId"); required(item.label, "supply constraint label"); required(item.description, "supply constraint description"); required(item.affectedVariable, "supply constraint affectedVariable"); assertRequiredEvidence(item.sourceReferences, "supply constraint");
}
function assertValueChainNode(item: ResearchIndustryValueChainNode): void {
  required(item.valueChainNodeId, "valueChainNodeId"); required(item.name, "value chain node name"); required(item.description, "value chain node description"); required(item.revenueRecognitionRole, "value chain revenueRecognitionRole"); assertRequiredEvidence(item.sourceReferences, "value chain node");
}
function assertKpi(item: ResearchIndustryKpi): void {
  required(item.kpiId, "kpiId"); required(item.name, "kpi name"); required(item.definition, "kpi definition"); required(item.unit, "kpi unit"); required(item.frequency, "kpi frequency"); required(item.financialMapping, "kpi financialMapping"); assertRequiredEvidence(item.sourceReferences, "industry kpi");
}
function assertPeerMember(member: ResearchPeerComparisonMember): void {
  required(member.peerComparisonMemberId, "peerComparisonMemberId"); required(member.peerName, "peerName");
  if (member.membershipStatus === "excluded" && !member.exclusionReason?.trim()) throw new Error("excluded peer members require an exclusion reason");
  assertRequiredEvidence(member.sourceReferences, "peer member");
  for (const dimension of member.dimensions) {
    required(dimension.comparisonDimensionId, "comparisonDimensionId");
    if (dimension.status === "adjustment_required" && !dimension.adjustmentNote?.trim()) throw new Error("adjustment-required comparison dimensions require an adjustment note");
    assertRequiredEvidence(dimension.sourceReferences, "comparison dimension");
  }
}
function assertVersionedEvidence(input: { asOf: number; version: number; epistemicType: ResearchPublicEpistemicType; sourceReferences: ResearchSourceReference[] }, label: string): void {
  assertAsOf(input.asOf);
  if (!Number.isInteger(input.version) || input.version <= 0) throw new Error(`${label} version must be a positive integer`);
  assertRequiredEvidence(input.sourceReferences, label);
  assertSourceReferences(input.epistemicType, input.sourceReferences);
}
function assertRequiredEvidence(references: ResearchSourceReference[], label: string): void {
  if (!references.length) throw new Error(`${label} requires at least one source reference`);
  assertSourceReferences("observed_fact", references);
}
function required(value: string, label: string): string { if (!value?.trim()) throw new Error(`${label} is required`); return value; }
export function availableIndustrySection<T>(items: T[]): ResearchIndustrySection<T> { return items.length ? { availability: "available", reason: null, items } : { availability: "empty", reason: "no_records", items: [] }; }
export function unavailableIndustrySection<T>(reason: Exclude<ResearchIndustryUnavailableReason, "no_records">): ResearchIndustrySection<T> { return { availability: "unavailable", reason, items: [] }; }
