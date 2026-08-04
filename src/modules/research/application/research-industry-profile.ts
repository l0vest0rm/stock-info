import {
  assertPeerMember,
  assertResearchIndustryRecord,
  availableIndustrySection,
  unavailableIndustrySection,
  type ResearchCompanyIndustryExposure,
  type ResearchIndustryProfile,
  type ResearchIndustrySection,
  type ResearchPeerUniverse,
  type ResearchPeerUniverseMember,
} from "../domain/research-industry-profile";
import { type ResearchSourceReference } from "../domain/research-dossier";

type Row = Record<string, unknown>;

export type ResearchIndustryWriteResult = { state: "saved" | "unavailable"; recordId: string; reason: "storage_not_initialized" | null };
export type LoadIndustryProfilesQuery = { industryKey: string; taxonomy?: string; asOf?: number };
export type LoadCompanyIndustryExposureQuery = { companyId: string | null; asOf: number };
export type LoadPeerUniversesQuery = { companyId: string | null; industryProfileId?: string; asOf: number };

export async function loadResearchIndustryProfiles(
  db: D1Database,
  query: LoadIndustryProfilesQuery,
): Promise<ResearchIndustrySection<ResearchIndustryProfile>> {
  const industryKey = query.industryKey.trim();
  if (!industryKey) throw new Error("industryKey is required");
  const asOf = query.asOf ?? Date.now();
  try {
    const rows = await db.prepare(`select * from research_industry_profiles
      where industry_key = ? and as_of <= ? and status <> 'superseded' and (? is null or taxonomy = ?)
      order by as_of desc, version desc, created_at desc, industry_profile_id`)
      .bind(industryKey, asOf, query.taxonomy ?? null, query.taxonomy ?? null).all<Row>();
    return availableIndustrySection(rows.results.map(mapIndustryProfile));
  } catch (error) {
    if (isMissingTable(error, "research_industry_profiles")) return unavailableIndustrySection("storage_not_initialized");
    throw error;
  }
}

export async function loadResearchCompanyIndustryExposures(
  db: D1Database,
  query: LoadCompanyIndustryExposureQuery,
): Promise<ResearchIndustrySection<ResearchCompanyIndustryExposure>> {
  if (!query.companyId) return unavailableIndustrySection("identity_not_found");
  try {
    const rows = await db.prepare(`select * from research_company_industry_exposures
      where company_id = ? and as_of <= ? and status <> 'superseded'
      order by as_of desc, version desc, created_at desc, exposure_id`).bind(query.companyId, query.asOf).all<Row>();
    return availableIndustrySection(rows.results.map(mapCompanyExposure));
  } catch (error) {
    if (isMissingTable(error, "research_company_industry_exposures")) return unavailableIndustrySection("storage_not_initialized");
    throw error;
  }
}

export async function loadResearchPeerUniverses(
  db: D1Database,
  query: LoadPeerUniversesQuery,
): Promise<ResearchIndustrySection<ResearchPeerUniverse>> {
  if (!query.companyId) return unavailableIndustrySection("identity_not_found");
  try {
    const rows = await db.prepare(`select * from research_peer_universes
      where company_id = ? and as_of <= ? and status <> 'superseded'
        and (? is null or industry_profile_id = ?)
      order by as_of desc, version desc, created_at desc, peer_universe_id`)
      .bind(query.companyId, query.asOf, query.industryProfileId ?? null, query.industryProfileId ?? null).all<Row>();
    const universes = rows.results.map(mapPeerUniverse);
    if (!universes.length) return availableIndustrySection(universes);
    const members = await db.prepare(`select * from research_peer_universe_members
      where peer_universe_id in (${placeholders(universes.length)})
      order by peer_universe_id, membership_status, sort_order, peer_member_id`)
      .bind(...universes.map((item) => item.peerUniverseId)).all<Row>();
    const byUniverse = groupRows(members.results, "peer_universe_id", mapPeerMember);
    return availableIndustrySection(universes.map((universe) => ({ ...universe, members: byUniverse.get(universe.peerUniverseId) ?? [] })));
  } catch (error) {
    if (isMissingTable(error, "research_peer_universes") || isMissingTable(error, "research_peer_universe_members")) {
      return unavailableIndustrySection("storage_not_initialized");
    }
    throw error;
  }
}

export async function insertResearchIndustryProfile(db: D1Database, input: ResearchIndustryProfile): Promise<ResearchIndustryWriteResult> {
  assertResearchIndustryRecord(input, "industry profile");
  return runInsert(db, "research_industry_profiles", input.industryProfileId, [db.prepare(`insert into research_industry_profiles (
    industry_profile_id, industry_key, taxonomy, taxonomy_version, industry_name, parent_industry_key,
    as_of, version, status, definition, demand_drivers_json, supply_structure_json, cycle_characteristics_json,
    value_chain_json, epistemic_type, source_refs_json, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    input.industryProfileId, input.industryKey, input.taxonomy, input.taxonomyVersion, input.industryName, input.parentIndustryKey,
    input.asOf, input.version, input.status, input.definition, JSON.stringify(input.demandDrivers), JSON.stringify(input.supplyStructure),
    JSON.stringify(input.cycleCharacteristics), JSON.stringify(input.valueChain), input.epistemicType, JSON.stringify(input.sourceReferences),
    input.createdAt, input.updatedAt,
  )]);
}

export async function insertResearchCompanyIndustryExposure(db: D1Database, input: ResearchCompanyIndustryExposure): Promise<ResearchIndustryWriteResult> {
  assertResearchIndustryRecord(input, "company industry exposure");
  if (input.selectionBasis !== "primary_business") throw new Error("company industry exposure must be selected from primary_business");
  if (!input.primaryBusinessDescription.trim()) throw new Error("company industry exposure requires a primary business description");
  return runInsert(db, "research_company_industry_exposures", input.exposureId, [db.prepare(`insert into research_company_industry_exposures (
    exposure_id, company_id, industry_profile_id, as_of, version, status, selection_basis, primary_business_description,
    exposure_scope_json, exposure_share_json, epistemic_type, source_refs_json, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    input.exposureId, input.companyId, input.industryProfileId, input.asOf, input.version, input.status, input.selectionBasis,
    input.primaryBusinessDescription, JSON.stringify(input.exposureScope), JSON.stringify(input.exposureShare), input.epistemicType,
    JSON.stringify(input.sourceReferences), input.createdAt, input.updatedAt,
  )]);
}

export async function insertResearchPeerUniverse(db: D1Database, input: ResearchPeerUniverse): Promise<ResearchIndustryWriteResult> {
  assertResearchIndustryRecord(input, "peer universe");
  if (!input.selectionCriteria.trim()) throw new Error("peer universe requires selection criteria");
  for (const member of input.members) assertPeerMember(member);
  const statements: D1PreparedStatement[] = [db.prepare(`insert into research_peer_universes (
    peer_universe_id, company_id, industry_profile_id, as_of, version, status, comparison_purpose, selection_criteria,
    cross_market_policy_json, epistemic_type, source_refs_json, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    input.peerUniverseId, input.companyId, input.industryProfileId, input.asOf, input.version, input.status,
    input.comparisonPurpose, input.selectionCriteria, JSON.stringify(input.crossMarketPolicy), input.epistemicType,
    JSON.stringify(input.sourceReferences), input.createdAt, input.updatedAt,
  )];
  for (const member of input.members) {
    statements.push(db.prepare(`insert into research_peer_universe_members (
      peer_member_id, peer_universe_id, company_id, security_code, peer_name, relationship_type, membership_status,
      comparability_status, exclusion_reason, comparison_dimensions_json, cross_market_metadata_json, source_refs_json, sort_order
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      member.peerMemberId, input.peerUniverseId, member.companyId, member.securityCode, member.peerName, member.relationshipType,
      member.membershipStatus, member.comparabilityStatus, member.exclusionReason, JSON.stringify(member.comparisonDimensions),
      JSON.stringify(member.crossMarketMetadata), JSON.stringify(member.sourceReferences), member.sortOrder,
    ));
  }
  return runInsert(db, "research_peer_universes", input.peerUniverseId, statements);
}

async function runInsert(db: D1Database, table: string, recordId: string, statements: D1PreparedStatement[]): Promise<ResearchIndustryWriteResult> {
  try {
    await db.batch(statements);
    return { state: "saved", recordId, reason: null };
  } catch (error) {
    if (isMissingTable(error, table)) return { state: "unavailable", recordId, reason: "storage_not_initialized" };
    throw error;
  }
}

function mapIndustryProfile(row: Row): ResearchIndustryProfile {
  const record: ResearchIndustryProfile = {
    industryProfileId: required(row.industry_profile_id, "industry_profile_id"), industryKey: required(row.industry_key, "industry_key"),
    taxonomy: required(row.taxonomy, "taxonomy"), taxonomyVersion: required(row.taxonomy_version, "taxonomy_version"),
    industryName: required(row.industry_name, "industry_name"), parentIndustryKey: nullable(row.parent_industry_key),
    asOf: number(row.as_of, "as_of"), version: number(row.version, "version"), status: required(row.status, "status") as ResearchIndustryProfile["status"],
    definition: required(row.definition, "definition"), demandDrivers: array(row.demand_drivers_json, "demand_drivers_json"),
    supplyStructure: object(row.supply_structure_json, "supply_structure_json"), cycleCharacteristics: object(row.cycle_characteristics_json, "cycle_characteristics_json"),
    valueChain: array(row.value_chain_json, "value_chain_json"), epistemicType: required(row.epistemic_type, "epistemic_type") as ResearchIndustryProfile["epistemicType"],
    sourceReferences: references(row.source_refs_json), createdAt: number(row.created_at, "created_at"), updatedAt: number(row.updated_at, "updated_at"),
  };
  assertResearchIndustryRecord(record, "industry profile");
  return record;
}

function mapCompanyExposure(row: Row): ResearchCompanyIndustryExposure {
  const record: ResearchCompanyIndustryExposure = {
    exposureId: required(row.exposure_id, "exposure_id"), companyId: required(row.company_id, "company_id"), industryProfileId: required(row.industry_profile_id, "industry_profile_id"),
    asOf: number(row.as_of, "as_of"), version: number(row.version, "version"), status: required(row.status, "status") as ResearchCompanyIndustryExposure["status"],
    selectionBasis: required(row.selection_basis, "selection_basis") as "primary_business", primaryBusinessDescription: required(row.primary_business_description, "primary_business_description"),
    exposureScope: object(row.exposure_scope_json, "exposure_scope_json"), exposureShare: object(row.exposure_share_json, "exposure_share_json"),
    epistemicType: required(row.epistemic_type, "epistemic_type") as ResearchCompanyIndustryExposure["epistemicType"], sourceReferences: references(row.source_refs_json),
    createdAt: number(row.created_at, "created_at"), updatedAt: number(row.updated_at, "updated_at"),
  };
  assertResearchIndustryRecord(record, "company industry exposure");
  if (record.selectionBasis !== "primary_business") throw new Error("company industry exposure must be selected from primary_business");
  return record;
}

function mapPeerUniverse(row: Row): ResearchPeerUniverse {
  const record: ResearchPeerUniverse = {
    peerUniverseId: required(row.peer_universe_id, "peer_universe_id"), companyId: required(row.company_id, "company_id"), industryProfileId: required(row.industry_profile_id, "industry_profile_id"),
    asOf: number(row.as_of, "as_of"), version: number(row.version, "version"), status: required(row.status, "status") as ResearchPeerUniverse["status"],
    comparisonPurpose: required(row.comparison_purpose, "comparison_purpose") as ResearchPeerUniverse["comparisonPurpose"], selectionCriteria: required(row.selection_criteria, "selection_criteria"),
    crossMarketPolicy: object(row.cross_market_policy_json, "cross_market_policy_json"), epistemicType: required(row.epistemic_type, "epistemic_type") as ResearchPeerUniverse["epistemicType"],
    sourceReferences: references(row.source_refs_json), members: [], createdAt: number(row.created_at, "created_at"), updatedAt: number(row.updated_at, "updated_at"),
  };
  assertResearchIndustryRecord(record, "peer universe");
  return record;
}

function mapPeerMember(row: Row): ResearchPeerUniverseMember {
  const record: ResearchPeerUniverseMember = {
    peerMemberId: required(row.peer_member_id, "peer_member_id"), companyId: nullable(row.company_id), securityCode: nullable(row.security_code),
    peerName: required(row.peer_name, "peer_name"), relationshipType: required(row.relationship_type, "relationship_type") as ResearchPeerUniverseMember["relationshipType"],
    membershipStatus: required(row.membership_status, "membership_status") as ResearchPeerUniverseMember["membershipStatus"],
    comparabilityStatus: required(row.comparability_status, "comparability_status") as ResearchPeerUniverseMember["comparabilityStatus"], exclusionReason: nullable(row.exclusion_reason),
    comparisonDimensions: object(row.comparison_dimensions_json, "comparison_dimensions_json"), crossMarketMetadata: object(row.cross_market_metadata_json, "cross_market_metadata_json"),
    sourceReferences: references(row.source_refs_json), sortOrder: number(row.sort_order, "sort_order"),
  };
  assertPeerMember(record);
  return record;
}

function groupRows<T>(rows: Row[], key: string, mapper: (row: Row) => T): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const group = required(row[key], key);
    const items = grouped.get(group) ?? [];
    items.push(mapper(row));
    grouped.set(group, items);
  }
  return grouped;
}

function placeholders(count: number): string { return Array.from({ length: count }, () => "?").join(", "); }
function required(value: unknown, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`research industry ${label} is required`); return result; }
function nullable(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function number(value: unknown, label: string): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error(`research industry ${label} must be numeric`); return result; }
function json(value: unknown, label: string): unknown { try { return typeof value === "string" ? JSON.parse(value) : value; } catch { throw new Error(`research industry ${label} must be valid JSON`); } }
function array(value: unknown, label: string): unknown[] { const result = json(value, label); if (!Array.isArray(result)) throw new Error(`research industry ${label} must be an array`); return result; }
function object(value: unknown, label: string): Record<string, unknown> { const result = json(value, label); if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(`research industry ${label} must be an object`); return result as Record<string, unknown>; }
function references(value: unknown): ResearchSourceReference[] { return array(value ?? "[]", "source_refs_json") as ResearchSourceReference[]; }
function isMissingTable(error: unknown, expectedTable: string): boolean { return new RegExp(`(?:no such table|does not exist|not found).*${expectedTable}`, "i").test(error instanceof Error ? error.message : String(error)); }
