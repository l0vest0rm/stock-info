import {
  assertResearchCompanyTrackExposure,
  assertResearchIndustryTrackProfile,
  assertResearchPeerComparisonSet,
  availableIndustrySection,
  unavailableIndustrySection,
  type ResearchCompanyTrackExposure,
  type ResearchCompanyTrackExposureShare,
  type ResearchIndustryDemandDriver,
  type ResearchIndustryKpi,
  type ResearchIndustrySection,
  type ResearchIndustrySupplyConstraint,
  type ResearchIndustryTrackProfile,
  type ResearchIndustryValueChainNode,
  type ResearchPeerComparisonDimension,
  type ResearchPeerComparisonMember,
  type ResearchPeerComparisonSet,
} from "../domain/research-industry-comparability";
import type { ResearchSourceReference } from "../domain/research-dossier";

type Row = Record<string, unknown>;
type EvidenceSubject = "track_profile" | "demand_driver" | "supply_constraint" | "value_chain_node" | "industry_kpi" | "company_exposure" | "exposure_share" | "peer_comparison_set" | "peer_member" | "comparison_dimension";
export type ResearchIndustryWriteResult = { state: "saved" | "unavailable"; recordId: string; reason: "storage_not_initialized" | null };

export async function insertResearchIndustryTrackProfile(db: D1Database, input: ResearchIndustryTrackProfile): Promise<ResearchIndustryWriteResult> {
  assertResearchIndustryTrackProfile(input);
  const statements: D1PreparedStatement[] = [db.prepare(`insert into research_industry_track_profiles (
    track_profile_id, industry_key, taxonomy, taxonomy_version, industry_name, parent_industry_key, as_of, version, status,
    boundary_included, boundary_excluded, demand_equation, supply_equation, cycle_position, valuation_primary_method,
    valuation_limitations, epistemic_type, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.trackProfileId, input.industryKey, input.taxonomy, input.taxonomyVersion, input.industryName, input.parentIndustryKey,
      input.asOf, input.version, input.status, input.boundaryIncluded, input.boundaryExcluded, input.demandEquation, input.supplyEquation,
      input.cyclePosition, input.valuationPrimaryMethod, input.valuationLimitations, input.epistemicType, input.createdAt, input.updatedAt),
    ...evidenceStatements(db, "track_profile", input.trackProfileId, input.sourceReferences, input.createdAt),
  ];
  for (const item of input.demandDrivers) statements.push(
    db.prepare(`insert into research_industry_track_demand_drivers (
      driver_id, track_profile_id, driver_kind, label, definition, indicator_name, indicator_frequency, leading_lagging, financial_transmission, sort_order
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(item.driverId, input.trackProfileId, item.driverKind, item.label, item.definition, item.indicatorName, item.indicatorFrequency, item.leadingLagging, item.financialTransmission, item.sortOrder),
    ...evidenceStatements(db, "demand_driver", item.driverId, item.sourceReferences, input.createdAt),
  );
  for (const item of input.supplyConstraints) statements.push(
    db.prepare(`insert into research_industry_track_supply_constraints (
      constraint_id, track_profile_id, constraint_kind, label, description, affected_variable, direction_when_binding, sort_order
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(item.constraintId, input.trackProfileId, item.constraintKind, item.label, item.description, item.affectedVariable, item.directionWhenBinding, item.sortOrder),
    ...evidenceStatements(db, "supply_constraint", item.constraintId, item.sourceReferences, input.createdAt),
  );
  for (const item of input.valueChainNodes) statements.push(
    db.prepare(`insert into research_industry_track_value_chain_nodes (
      value_chain_node_id, track_profile_id, node_role, name, description, revenue_recognition_role, sort_order
    ) values (?, ?, ?, ?, ?, ?, ?)`)
      .bind(item.valueChainNodeId, input.trackProfileId, item.nodeRole, item.name, item.description, item.revenueRecognitionRole, item.sortOrder),
    ...evidenceStatements(db, "value_chain_node", item.valueChainNodeId, item.sourceReferences, input.createdAt),
  );
  for (const item of input.kpis) statements.push(
    db.prepare(`insert into research_industry_track_kpis (
      kpi_id, track_profile_id, name, definition, unit, frequency, timing_role, financial_mapping, sort_order
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(item.kpiId, input.trackProfileId, item.name, item.definition, item.unit, item.frequency, item.timingRole, item.financialMapping, item.sortOrder),
    ...evidenceStatements(db, "industry_kpi", item.kpiId, item.sourceReferences, input.createdAt),
  );
  return runInsert(db, "research_industry_track_profiles", input.trackProfileId, statements);
}

export async function insertResearchCompanyTrackExposure(db: D1Database, input: ResearchCompanyTrackExposure): Promise<ResearchIndustryWriteResult> {
  assertResearchCompanyTrackExposure(input);
  const statements: D1PreparedStatement[] = [db.prepare(`insert into research_company_track_exposures (
    company_track_exposure_id, company_id, track_profile_id, as_of, version, status, selection_basis, business_segment,
    product_scope, geographic_scope, customer_scope, exposure_description, epistemic_type, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.companyTrackExposureId, input.companyId, input.trackProfileId, input.asOf, input.version, input.status,
      input.selectionBasis, input.businessSegment, input.productScope, input.geographicScope, input.customerScope,
      input.exposureDescription, input.epistemicType, input.createdAt, input.updatedAt),
    ...evidenceStatements(db, "company_exposure", input.companyTrackExposureId, input.sourceReferences, input.createdAt),
  ];
  for (const share of input.shares) statements.push(
    db.prepare(`insert into research_company_track_exposure_shares (
      exposure_share_id, company_track_exposure_id, measure, value, unit, basis_period, denominator_description, sort_order
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(share.exposureShareId, input.companyTrackExposureId, share.measure, share.value, share.unit, share.basisPeriod, share.denominatorDescription, share.sortOrder),
    ...evidenceStatements(db, "exposure_share", share.exposureShareId, share.sourceReferences, input.createdAt),
  );
  return runInsert(db, "research_company_track_exposures", input.companyTrackExposureId, statements);
}

export async function insertResearchPeerComparisonSet(db: D1Database, input: ResearchPeerComparisonSet): Promise<ResearchIndustryWriteResult> {
  assertResearchPeerComparisonSet(input);
  const statements: D1PreparedStatement[] = [db.prepare(`insert into research_peer_comparison_sets (
    peer_comparison_set_id, company_id, track_profile_id, as_of, version, status, comparison_purpose, selection_criteria,
    epistemic_type, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.peerComparisonSetId, input.companyId, input.trackProfileId, input.asOf, input.version, input.status,
      input.comparisonPurpose, input.selectionCriteria, input.epistemicType, input.createdAt, input.updatedAt),
    ...evidenceStatements(db, "peer_comparison_set", input.peerComparisonSetId, input.sourceReferences, input.createdAt),
  ];
  for (const member of input.members) {
    statements.push(db.prepare(`insert into research_peer_comparison_members (
      peer_comparison_member_id, peer_comparison_set_id, company_id, security_code, peer_name, relationship_type,
      membership_status, comparability_status, exclusion_reason, sort_order
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(member.peerComparisonMemberId, input.peerComparisonSetId, member.companyId, member.securityCode, member.peerName,
        member.relationshipType, member.membershipStatus, member.comparabilityStatus, member.exclusionReason, member.sortOrder),
    ...evidenceStatements(db, "peer_member", member.peerComparisonMemberId, member.sourceReferences, input.createdAt));
    for (const dimension of member.dimensions) statements.push(
      db.prepare(`insert into research_peer_comparison_dimensions (
        comparison_dimension_id, peer_comparison_member_id, dimension, status, target_value, peer_value, adjustment_note, sort_order
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(dimension.comparisonDimensionId, member.peerComparisonMemberId, dimension.dimension, dimension.status,
          dimension.targetValue, dimension.peerValue, dimension.adjustmentNote, dimension.sortOrder),
      ...evidenceStatements(db, "comparison_dimension", dimension.comparisonDimensionId, dimension.sourceReferences, input.createdAt),
    );
  }
  return runInsert(db, "research_peer_comparison_sets", input.peerComparisonSetId, statements);
}

export async function loadResearchIndustryTrackProfiles(db: D1Database, query: { industryKey: string; taxonomy?: string; asOf?: number }): Promise<ResearchIndustrySection<ResearchIndustryTrackProfile>> {
  const industryKey = required(query.industryKey, "industryKey"); const asOf = query.asOf ?? Date.now();
  try {
    const rows = await db.prepare(`select * from research_industry_track_profiles where industry_key=? and as_of<=? and status<>'superseded'
      and (? is null or taxonomy=?) order by as_of desc, version desc, created_at desc, track_profile_id`)
      .bind(industryKey, asOf, query.taxonomy ?? null, query.taxonomy ?? null).all<Row>();
    return availableIndustrySection(await hydrateProfiles(db, rows.results));
  } catch (error) { if (isMissingTable(error, "research_industry_track_profiles")) return unavailableIndustrySection("storage_not_initialized"); throw error; }
}

export async function loadResearchCompanyTrackExposures(db: D1Database, query: { companyId: string | null; asOf: number }): Promise<ResearchIndustrySection<ResearchCompanyTrackExposure>> {
  if (!query.companyId) return unavailableIndustrySection("identity_not_found");
  try {
    const rows = await db.prepare(`select * from research_company_track_exposures where company_id=? and as_of<=? and status<>'superseded'
      order by as_of desc, version desc, created_at desc, company_track_exposure_id`).bind(query.companyId, query.asOf).all<Row>();
    return availableIndustrySection(await hydrateExposures(db, rows.results));
  } catch (error) { if (isMissingTable(error, "research_company_track_exposures")) return unavailableIndustrySection("storage_not_initialized"); throw error; }
}

export async function loadResearchPeerComparisonSets(db: D1Database, query: { companyId: string | null; trackProfileId?: string; asOf: number }): Promise<ResearchIndustrySection<ResearchPeerComparisonSet>> {
  if (!query.companyId) return unavailableIndustrySection("identity_not_found");
  try {
    const rows = await db.prepare(`select * from research_peer_comparison_sets where company_id=? and as_of<=? and status<>'superseded'
      and (? is null or track_profile_id=?) order by as_of desc, version desc, created_at desc, peer_comparison_set_id`)
      .bind(query.companyId, query.asOf, query.trackProfileId ?? null, query.trackProfileId ?? null).all<Row>();
    return availableIndustrySection(await hydratePeerSets(db, rows.results));
  } catch (error) { if (isMissingTable(error, "research_peer_comparison_sets")) return unavailableIndustrySection("storage_not_initialized"); throw error; }
}

async function hydrateProfiles(db: D1Database, rows: Row[]): Promise<ResearchIndustryTrackProfile[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => required(row.track_profile_id, "track_profile_id"));
  const [drivers, constraints, nodes, kpis] = await Promise.all([
    listBy(db, "research_industry_track_demand_drivers", "track_profile_id", ids), listBy(db, "research_industry_track_supply_constraints", "track_profile_id", ids),
    listBy(db, "research_industry_track_value_chain_nodes", "track_profile_id", ids), listBy(db, "research_industry_track_kpis", "track_profile_id", ids),
  ]);
  const evidence = await evidenceFor(db, ["track_profile", "demand_driver", "supply_constraint", "value_chain_node", "industry_kpi"], [
    ...ids, ...drivers.map((row) => required(row.driver_id, "driver_id")), ...constraints.map((row) => required(row.constraint_id, "constraint_id")),
    ...nodes.map((row) => required(row.value_chain_node_id, "value_chain_node_id")), ...kpis.map((row) => required(row.kpi_id, "kpi_id")),
  ]);
  const refs = groupEvidence(evidence);
  const driversBy = groupBy(drivers, "track_profile_id", (row) => mapDriver(row, refs));
  const constraintsBy = groupBy(constraints, "track_profile_id", (row) => mapConstraint(row, refs));
  const nodesBy = groupBy(nodes, "track_profile_id", (row) => mapNode(row, refs));
  const kpisBy = groupBy(kpis, "track_profile_id", (row) => mapKpi(row, refs));
  return rows.map((row) => ({ trackProfileId: required(row.track_profile_id, "track_profile_id"), industryKey: required(row.industry_key, "industry_key"), taxonomy: required(row.taxonomy, "taxonomy"), taxonomyVersion: required(row.taxonomy_version, "taxonomy_version"), industryName: required(row.industry_name, "industry_name"), parentIndustryKey: nullable(row.parent_industry_key), asOf: number(row.as_of, "as_of"), version: number(row.version, "version"), status: required(row.status, "status") as ResearchIndustryTrackProfile["status"], boundaryIncluded: required(row.boundary_included, "boundary_included"), boundaryExcluded: required(row.boundary_excluded, "boundary_excluded"), demandEquation: nullable(row.demand_equation), supplyEquation: nullable(row.supply_equation), cyclePosition: required(row.cycle_position, "cycle_position") as ResearchIndustryTrackProfile["cyclePosition"], valuationPrimaryMethod: nullable(row.valuation_primary_method), valuationLimitations: nullable(row.valuation_limitations), epistemicType: required(row.epistemic_type, "epistemic_type") as ResearchIndustryTrackProfile["epistemicType"], sourceReferences: refs.get(key("track_profile", required(row.track_profile_id, "track_profile_id"))) ?? [], demandDrivers: driversBy.get(required(row.track_profile_id, "track_profile_id")) ?? [], supplyConstraints: constraintsBy.get(required(row.track_profile_id, "track_profile_id")) ?? [], valueChainNodes: nodesBy.get(required(row.track_profile_id, "track_profile_id")) ?? [], kpis: kpisBy.get(required(row.track_profile_id, "track_profile_id")) ?? [], createdAt: number(row.created_at, "created_at"), updatedAt: number(row.updated_at, "updated_at") }));
}

async function hydrateExposures(db: D1Database, rows: Row[]): Promise<ResearchCompanyTrackExposure[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => required(row.company_track_exposure_id, "company_track_exposure_id"));
  const shares = await listBy(db, "research_company_track_exposure_shares", "company_track_exposure_id", ids);
  const evidence = await evidenceFor(db, ["company_exposure", "exposure_share"], [...ids, ...shares.map((row) => required(row.exposure_share_id, "exposure_share_id"))]);
  const refs = groupEvidence(evidence); const sharesBy = groupBy(shares, "company_track_exposure_id", (row) => mapShare(row, refs));
  return rows.map((row) => ({ companyTrackExposureId: required(row.company_track_exposure_id, "company_track_exposure_id"), companyId: required(row.company_id, "company_id"), trackProfileId: required(row.track_profile_id, "track_profile_id"), asOf: number(row.as_of, "as_of"), version: number(row.version, "version"), status: required(row.status, "status") as ResearchCompanyTrackExposure["status"], selectionBasis: required(row.selection_basis, "selection_basis") as ResearchCompanyTrackExposure["selectionBasis"], businessSegment: required(row.business_segment, "business_segment"), productScope: required(row.product_scope, "product_scope"), geographicScope: required(row.geographic_scope, "geographic_scope"), customerScope: required(row.customer_scope, "customer_scope"), exposureDescription: required(row.exposure_description, "exposure_description"), epistemicType: required(row.epistemic_type, "epistemic_type") as ResearchCompanyTrackExposure["epistemicType"], sourceReferences: refs.get(key("company_exposure", required(row.company_track_exposure_id, "company_track_exposure_id"))) ?? [], shares: sharesBy.get(required(row.company_track_exposure_id, "company_track_exposure_id")) ?? [], createdAt: number(row.created_at, "created_at"), updatedAt: number(row.updated_at, "updated_at") }));
}

async function hydratePeerSets(db: D1Database, rows: Row[]): Promise<ResearchPeerComparisonSet[]> {
  if (!rows.length) return [];
  const setIds = rows.map((row) => required(row.peer_comparison_set_id, "peer_comparison_set_id")); const members = await listBy(db, "research_peer_comparison_members", "peer_comparison_set_id", setIds);
  const memberIds = members.map((row) => required(row.peer_comparison_member_id, "peer_comparison_member_id"));
  const dimensions = memberIds.length ? await listBy(db, "research_peer_comparison_dimensions", "peer_comparison_member_id", memberIds) : [];
  const evidence = await evidenceFor(db, ["peer_comparison_set", "peer_member", "comparison_dimension"], [...setIds, ...memberIds, ...dimensions.map((row) => required(row.comparison_dimension_id, "comparison_dimension_id"))]);
  const refs = groupEvidence(evidence); const dimensionsBy = groupBy(dimensions, "peer_comparison_member_id", (row) => mapDimension(row, refs));
  const membersBy = groupBy(members, "peer_comparison_set_id", (row) => mapMember(row, refs, dimensionsBy));
  return rows.map((row) => ({ peerComparisonSetId: required(row.peer_comparison_set_id, "peer_comparison_set_id"), companyId: required(row.company_id, "company_id"), trackProfileId: required(row.track_profile_id, "track_profile_id"), asOf: number(row.as_of, "as_of"), version: number(row.version, "version"), status: required(row.status, "status") as ResearchPeerComparisonSet["status"], comparisonPurpose: required(row.comparison_purpose, "comparison_purpose") as ResearchPeerComparisonSet["comparisonPurpose"], selectionCriteria: required(row.selection_criteria, "selection_criteria"), epistemicType: required(row.epistemic_type, "epistemic_type") as ResearchPeerComparisonSet["epistemicType"], sourceReferences: refs.get(key("peer_comparison_set", required(row.peer_comparison_set_id, "peer_comparison_set_id"))) ?? [], members: membersBy.get(required(row.peer_comparison_set_id, "peer_comparison_set_id")) ?? [], createdAt: number(row.created_at, "created_at"), updatedAt: number(row.updated_at, "updated_at") }));
}

function mapDriver(row: Row, refs: Map<string, ResearchSourceReference[]>): ResearchIndustryDemandDriver { const id = required(row.driver_id, "driver_id"); return { driverId: id, driverKind: required(row.driver_kind, "driver_kind") as ResearchIndustryDemandDriver["driverKind"], label: required(row.label, "label"), definition: required(row.definition, "definition"), indicatorName: nullable(row.indicator_name), indicatorFrequency: nullable(row.indicator_frequency), leadingLagging: required(row.leading_lagging, "leading_lagging") as ResearchIndustryDemandDriver["leadingLagging"], financialTransmission: required(row.financial_transmission, "financial_transmission"), sortOrder: number(row.sort_order, "sort_order"), sourceReferences: refs.get(key("demand_driver", id)) ?? [] }; }
function mapConstraint(row: Row, refs: Map<string, ResearchSourceReference[]>): ResearchIndustrySupplyConstraint { const id = required(row.constraint_id, "constraint_id"); return { constraintId: id, constraintKind: required(row.constraint_kind, "constraint_kind") as ResearchIndustrySupplyConstraint["constraintKind"], label: required(row.label, "label"), description: required(row.description, "description"), affectedVariable: required(row.affected_variable, "affected_variable"), directionWhenBinding: required(row.direction_when_binding, "direction_when_binding") as ResearchIndustrySupplyConstraint["directionWhenBinding"], sortOrder: number(row.sort_order, "sort_order"), sourceReferences: refs.get(key("supply_constraint", id)) ?? [] }; }
function mapNode(row: Row, refs: Map<string, ResearchSourceReference[]>): ResearchIndustryValueChainNode { const id = required(row.value_chain_node_id, "value_chain_node_id"); return { valueChainNodeId: id, nodeRole: required(row.node_role, "node_role") as ResearchIndustryValueChainNode["nodeRole"], name: required(row.name, "name"), description: required(row.description, "description"), revenueRecognitionRole: required(row.revenue_recognition_role, "revenue_recognition_role"), sortOrder: number(row.sort_order, "sort_order"), sourceReferences: refs.get(key("value_chain_node", id)) ?? [] }; }
function mapKpi(row: Row, refs: Map<string, ResearchSourceReference[]>): ResearchIndustryKpi { const id = required(row.kpi_id, "kpi_id"); return { kpiId: id, name: required(row.name, "name"), definition: required(row.definition, "definition"), unit: required(row.unit, "unit"), frequency: required(row.frequency, "frequency"), timingRole: required(row.timing_role, "timing_role") as ResearchIndustryKpi["timingRole"], financialMapping: required(row.financial_mapping, "financial_mapping"), sortOrder: number(row.sort_order, "sort_order"), sourceReferences: refs.get(key("industry_kpi", id)) ?? [] }; }
function mapShare(row: Row, refs: Map<string, ResearchSourceReference[]>): ResearchCompanyTrackExposureShare { const id = required(row.exposure_share_id, "exposure_share_id"); return { exposureShareId: id, measure: required(row.measure, "measure") as ResearchCompanyTrackExposureShare["measure"], value: number(row.value, "value"), unit: required(row.unit, "unit") as ResearchCompanyTrackExposureShare["unit"], basisPeriod: required(row.basis_period, "basis_period"), denominatorDescription: nullable(row.denominator_description), sortOrder: number(row.sort_order, "sort_order"), sourceReferences: refs.get(key("exposure_share", id)) ?? [] }; }
function mapDimension(row: Row, refs: Map<string, ResearchSourceReference[]>): ResearchPeerComparisonDimension { const id = required(row.comparison_dimension_id, "comparison_dimension_id"); return { comparisonDimensionId: id, dimension: required(row.dimension, "dimension") as ResearchPeerComparisonDimension["dimension"], status: required(row.status, "status") as ResearchPeerComparisonDimension["status"], targetValue: nullable(row.target_value), peerValue: nullable(row.peer_value), adjustmentNote: nullable(row.adjustment_note), sortOrder: number(row.sort_order, "sort_order"), sourceReferences: refs.get(key("comparison_dimension", id)) ?? [] }; }
function mapMember(row: Row, refs: Map<string, ResearchSourceReference[]>, dimensionsBy: Map<string, ResearchPeerComparisonDimension[]>): ResearchPeerComparisonMember { const id = required(row.peer_comparison_member_id, "peer_comparison_member_id"); return { peerComparisonMemberId: id, companyId: nullable(row.company_id), securityCode: nullable(row.security_code), peerName: required(row.peer_name, "peer_name"), relationshipType: required(row.relationship_type, "relationship_type") as ResearchPeerComparisonMember["relationshipType"], membershipStatus: required(row.membership_status, "membership_status") as ResearchPeerComparisonMember["membershipStatus"], comparabilityStatus: required(row.comparability_status, "comparability_status") as ResearchPeerComparisonMember["comparabilityStatus"], exclusionReason: nullable(row.exclusion_reason), sortOrder: number(row.sort_order, "sort_order"), sourceReferences: refs.get(key("peer_member", id)) ?? [], dimensions: dimensionsBy.get(id) ?? [] }; }

function evidenceStatements(db: D1Database, subjectType: EvidenceSubject, subjectId: string, refs: ResearchSourceReference[], createdAt: number): D1PreparedStatement[] { return refs.map((ref, index) => db.prepare(`insert into research_industry_comparability_evidence_refs (
  evidence_ref_id, subject_type, subject_id, source_kind, source_id, information_id, version_id, document_id, url, title, published_at, locator, created_at
) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(`${subjectId}:evidence:${index + 1}`, subjectType, subjectId, ref.sourceKind, nullable(ref.sourceId), nullable(ref.informationId), nullable(ref.versionId), nullable(ref.documentId), nullable(ref.url), nullable(ref.title), ref.publishedAt === undefined ? null : String(ref.publishedAt), nullable(ref.locator), createdAt)); }
async function evidenceFor(db: D1Database, subjectTypes: EvidenceSubject[], subjectIds: string[]): Promise<Row[]> { if (!subjectIds.length) return []; const types = placeholders(subjectTypes.length); const ids = placeholders(subjectIds.length); const rows = await db.prepare(`select * from research_industry_comparability_evidence_refs where subject_type in (${types}) and subject_id in (${ids}) order by created_at, evidence_ref_id`).bind(...subjectTypes, ...subjectIds).all<Row>(); return rows.results; }
function groupEvidence(rows: Row[]): Map<string, ResearchSourceReference[]> { const result = new Map<string, ResearchSourceReference[]>(); for (const row of rows) { const item: ResearchSourceReference = { sourceKind: required(row.source_kind, "source_kind") as ResearchSourceReference["sourceKind"], sourceId: nullable(row.source_id) ?? undefined, informationId: nullable(row.information_id) ?? undefined, versionId: nullable(row.version_id) ?? undefined, documentId: nullable(row.document_id) ?? undefined, url: nullable(row.url) ?? undefined, title: nullable(row.title) ?? undefined, publishedAt: nullable(row.published_at) ?? undefined, locator: nullable(row.locator) ?? undefined }; const group = result.get(key(required(row.subject_type, "subject_type") as EvidenceSubject, required(row.subject_id, "subject_id"))) ?? []; group.push(item); result.set(key(required(row.subject_type, "subject_type") as EvidenceSubject, required(row.subject_id, "subject_id")), group); } return result; }
async function listBy(db: D1Database, table: string, column: string, ids: string[]): Promise<Row[]> { if (!ids.length) return []; const rows = await db.prepare(`select * from ${table} where ${column} in (${placeholders(ids.length)}) order by sort_order, rowid`).bind(...ids).all<Row>(); return rows.results; }
function groupBy<T>(rows: Row[], field: string, mapper: (row: Row) => T): Map<string, T[]> { const result = new Map<string, T[]>(); for (const row of rows) { const id = required(row[field], field); const items = result.get(id) ?? []; items.push(mapper(row)); result.set(id, items); } return result; }
async function runInsert(db: D1Database, table: string, recordId: string, statements: D1PreparedStatement[]): Promise<ResearchIndustryWriteResult> { try { await db.batch(statements); return { state: "saved", recordId, reason: null }; } catch (error) { if (isMissingTable(error, table)) return { state: "unavailable", recordId, reason: "storage_not_initialized" }; throw error; } }
function key(subjectType: EvidenceSubject, subjectId: string): string { return `${subjectType}:${subjectId}`; }
function placeholders(count: number): string { return Array.from({ length: count }, () => "?").join(", "); }
function required(value: unknown, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`research industry comparability ${label} is required`); return result; }
function nullable(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function number(value: unknown, label: string): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error(`research industry comparability ${label} must be numeric`); return result; }
function isMissingTable(error: unknown, table: string): boolean { return new RegExp(`(?:no such table|does not exist|not found).*${table}`, "i").test(error instanceof Error ? error.message : String(error)); }
