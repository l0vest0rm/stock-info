import type { SecurityRecord } from "../../../types";
import {
  buildFinancialCoverage,
  classifyResearchSecurity,
  resolveResearchInstrumentKind,
  type FinancialAvailabilityObservation,
  type FinancialAvailabilityStatus,
  type FinancialSourceRole,
  type FinancialStatementType,
  type SecurityRightsEvidenceKind,
  validateSecurityRightsEvidence,
} from "../domain/research-identity";

export type OperatingCompanyWrite = {
  companyId: string;
  canonicalName: string;
  reportingCurrency?: string | null;
  fiscalYearEnd?: string | null;
  identityStatus: "confirmed" | "provisional" | "needs_review";
  metadata?: Record<string, unknown>;
  now?: number;
};

export type ListedSecurityWrite = {
  security: SecurityRecord;
  shareClass?: string | null;
  depositaryRatio?: number | null;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type CompanySecurityRelationshipWrite = {
  relationshipId: string;
  companyId: string;
  securityCode: string;
  relationshipType: "primary_listing" | "secondary_listing" | "depositary_receipt" | "other_equity_claim";
  relationshipStatus: "confirmed" | "provisional" | "needs_review" | "conflicting";
  sourceUrl?: string | null;
  sourceNote?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type ProviderIdentifierWrite = {
  identifierId: string;
  ownerType: "operating_company" | "listed_security";
  companyId?: string | null;
  securityCode?: string | null;
  provider: string;
  identifierKind: string;
  identifierValue: string;
  identifierStatus: "confirmed" | "provisional" | "needs_review" | "conflicting" | "inactive";
  sourceUrl?: string | null;
  sourceNote?: string | null;
  observedAt: number;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type FinancialAvailabilityWrite = {
  observationId: string;
  securityCode: string;
  statementType: FinancialStatementType;
  provider: string;
  sourceRole: FinancialSourceRole;
  status: FinancialAvailabilityStatus;
  asOf: number;
  latestPeriod?: string | null;
  reportingCurrency?: string | null;
  accountingBasis?: string | null;
  sourceUrl?: string | null;
  blockingReason?: string | null;
  details?: Record<string, unknown>;
  now?: number;
};

export type SecurityRightsProfileWrite = {
  rightsProfileId: string;
  securityCode: string;
  rightsStatus: "confirmed" | "provisional" | "needs_review" | "conflicting";
  holderStructure: "direct_registered_holder" | "beneficial_holder" | "depositary_receipt_holder" | "other";
  legalIssuerName?: string | null;
  votingRightsNote?: string | null;
  economicRightsNote?: string | null;
  transferabilityNote?: string | null;
  structuralRiskNote?: string | null;
  depositaryName?: string | null;
  depositaryFeeNote?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  evidenceKind: SecurityRightsEvidenceKind;
  sourceUrl: string;
  sourceTitle: string;
  sourceNote: string;
  observedAt: number;
  metadata?: Record<string, unknown>;
  now?: number;
};

export type SecurityRightsLinkWrite = {
  rightsLinkId: string;
  securityCode: string;
  relatedSecurityCode: string;
  relationshipKind: "same_operating_company_different_security" | "adr_underlying_security" | "other_security_right";
  relationshipStatus: "confirmed" | "provisional" | "needs_review" | "conflicting";
  relatedSharesPerSecurity?: number | null;
  conversionAvailability: "available" | "restricted" | "not_available" | "unknown" | "not_applicable";
  relationshipNote: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  evidenceKind: SecurityRightsEvidenceKind;
  sourceUrl: string;
  sourceTitle: string;
  sourceNote: string;
  observedAt: number;
  metadata?: Record<string, unknown>;
  now?: number;
};

export async function upsertOperatingCompany(db: D1Database, input: OperatingCompanyWrite): Promise<void> {
  const companyId = required(input.companyId, "companyId");
  const canonicalName = required(input.canonicalName, "canonicalName");
  const now = input.now ?? Date.now();
  await db.prepare(`insert into research_operating_companies (
      company_id, canonical_name, reporting_currency, fiscal_year_end, identity_status, metadata_json, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(company_id) do update set canonical_name=excluded.canonical_name,
      reporting_currency=excluded.reporting_currency, fiscal_year_end=excluded.fiscal_year_end,
      identity_status=excluded.identity_status, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`)
    .bind(companyId, canonicalName, nullable(input.reportingCurrency), nullable(input.fiscalYearEnd), input.identityStatus,
      JSON.stringify(input.metadata ?? {}), now, now).run();
}

export async function upsertListedSecurity(db: D1Database, input: ListedSecurityWrite): Promise<void> {
  const classified = classifyResearchSecurity({
    code: input.security.code,
    name: input.security.name,
    instrumentType: input.security.type,
  });
  const now = input.now ?? Date.now();
  const depositaryRatio = finitePositiveOrNull(input.depositaryRatio);
  const metadata = {
    ...(input.metadata ?? {}),
    instrumentKind: classified.instrumentKind,
    eligibility: classified.eligibility,
    sourceSecurityName: input.security.name,
  };
  await db.prepare(`insert into research_listed_securities (
      security_code, company_id, venue, trading_currency, share_class, depositary_ratio,
      mapping_status, mapping_basis, metadata_json, created_at, updated_at
    ) values (?, null, ?, ?, ?, ?, 'unresolved', null, ?, ?, ?)
    on conflict(security_code) do update set venue=excluded.venue, trading_currency=excluded.trading_currency,
      share_class=excluded.share_class, depositary_ratio=excluded.depositary_ratio,
      metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`)
    .bind(classified.code, required(input.security.market, "security.market"), nullable(input.security.currency),
      nullable(input.shareClass), depositaryRatio, JSON.stringify(metadata), now, now).run();
}

export async function upsertCompanySecurityRelationship(
  db: D1Database,
  input: CompanySecurityRelationshipWrite,
): Promise<void> {
  const classified = classifyResearchSecurity({ code: input.securityCode, instrumentType: "stock" });
  const now = input.now ?? Date.now();
  await db.prepare(`insert into research_company_security_relationships (
      relationship_id, company_id, security_code, relationship_type, relationship_status,
      source_url, source_note, effective_from, effective_to, metadata_json, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(company_id, security_code, relationship_type) do update set
      relationship_status=excluded.relationship_status, source_url=excluded.source_url,
      source_note=excluded.source_note, effective_from=excluded.effective_from,
      effective_to=excluded.effective_to, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`)
    .bind(required(input.relationshipId, "relationshipId"), required(input.companyId, "companyId"), classified.code,
      input.relationshipType, input.relationshipStatus, nullable(input.sourceUrl), nullable(input.sourceNote),
      nullable(input.effectiveFrom), nullable(input.effectiveTo), JSON.stringify(input.metadata ?? {}), now, now).run();
  const mappingStatus = input.relationshipStatus === "confirmed" ? "confirmed"
    : input.relationshipStatus === "provisional" ? "provisional" : null;
  if (mappingStatus) {
    await db.prepare(`update research_listed_securities set company_id=?, mapping_status=?, mapping_basis=?, updated_at=?
      where security_code=?`)
      .bind(input.companyId, mappingStatus, required(input.sourceNote || input.sourceUrl || input.relationshipType, "mapping basis"), now, classified.code).run();
  } else if (input.relationshipStatus === "conflicting") {
    await db.prepare(`update research_listed_securities set mapping_status='conflicting', mapping_basis=?, updated_at=?
      where security_code=?`)
      .bind(required(input.sourceNote || input.sourceUrl || input.relationshipType, "mapping basis"), now, classified.code).run();
  }
}

export async function upsertProviderIdentifier(db: D1Database, input: ProviderIdentifierWrite): Promise<void> {
  const companyId = nullable(input.companyId);
  const securityCode = input.securityCode
    ? classifyResearchSecurity({ code: input.securityCode, instrumentType: "stock" }).code
    : null;
  if (input.ownerType === "operating_company" && (!companyId || securityCode)) {
    throw new Error("operating_company provider identifiers require only companyId");
  }
  if (input.ownerType === "listed_security" && (!securityCode || companyId)) {
    throw new Error("listed_security provider identifiers require only securityCode");
  }
  const now = input.now ?? Date.now();
  await db.prepare(`insert into research_provider_identifiers (
      identifier_id, owner_type, company_id, security_code, provider, identifier_kind,
      identifier_value, identifier_status, source_url, source_note, observed_at,
      metadata_json, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(owner_type, provider, identifier_kind, identifier_value) do update set
      company_id=excluded.company_id, security_code=excluded.security_code,
      identifier_status=excluded.identifier_status, source_url=excluded.source_url,
      source_note=excluded.source_note, observed_at=excluded.observed_at,
      metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`)
    .bind(required(input.identifierId, "identifierId"), input.ownerType, companyId, securityCode,
      required(input.provider, "provider"), required(input.identifierKind, "identifierKind"),
      required(input.identifierValue, "identifierValue"), input.identifierStatus, nullable(input.sourceUrl),
      nullable(input.sourceNote), input.observedAt, JSON.stringify(input.metadata ?? {}), now, now).run();
}

export async function putFinancialAvailabilityObservation(
  db: D1Database,
  input: FinancialAvailabilityWrite,
): Promise<void> {
  const code = classifyResearchSecurity({ code: input.securityCode, instrumentType: "stock" }).code;
  const now = input.now ?? Date.now();
  if (input.status === "verified_available" && !input.latestPeriod) {
    throw new Error("verified financial availability requires latestPeriod");
  }
  await db.prepare(`insert into research_financial_availability_observations (
      observation_id, security_code, statement_type, provider, source_role, availability_status,
      as_of, latest_period, reporting_currency, accounting_basis, source_url, blocking_reason,
      details_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(security_code, statement_type, provider, source_role, as_of) do update set
      availability_status=excluded.availability_status, latest_period=excluded.latest_period,
      reporting_currency=excluded.reporting_currency, accounting_basis=excluded.accounting_basis,
      source_url=excluded.source_url, blocking_reason=excluded.blocking_reason,
      details_json=excluded.details_json`)
    .bind(required(input.observationId, "observationId"), code, input.statementType,
      required(input.provider, "provider"), input.sourceRole, input.status, input.asOf,
      nullable(input.latestPeriod), nullable(input.reportingCurrency), nullable(input.accountingBasis),
      nullable(input.sourceUrl), nullable(input.blockingReason), JSON.stringify(input.details ?? {}), now).run();
}

/** Append a dated, source-bound description of one security's holder rights. */
export async function insertSecurityRightsProfile(db: D1Database, input: SecurityRightsProfileWrite): Promise<void> {
  const securityCode = classifyResearchSecurity({ code: input.securityCode, instrumentType: "stock" }).code;
  const evidence = validateSecurityRightsEvidence(input);
  const now = input.now ?? Date.now();
  await db.prepare(`insert into research_security_rights_profiles (
      rights_profile_id, security_code, rights_status, holder_structure, legal_issuer_name,
      voting_rights_note, economic_rights_note, transferability_note, structural_risk_note,
      depositary_name, depositary_fee_note, effective_from, effective_to, evidence_kind,
      source_url, source_title, source_note, observed_at, metadata_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(required(input.rightsProfileId, "rightsProfileId"), securityCode, input.rightsStatus, input.holderStructure,
      nullable(input.legalIssuerName), nullable(input.votingRightsNote), nullable(input.economicRightsNote),
      nullable(input.transferabilityNote), nullable(input.structuralRiskNote), nullable(input.depositaryName),
      nullable(input.depositaryFeeNote), nullable(input.effectiveFrom), nullable(input.effectiveTo), evidence.evidenceKind,
      evidence.sourceUrl, evidence.sourceTitle, evidence.sourceNote, requiredTimestamp(input.observedAt, "observedAt"),
      JSON.stringify(input.metadata ?? {}), now).run();
}

/**
 * Persist an explicit cross-security relationship.  A confirmed link is accepted
 * only after both legs are independently mapped to the same confirmed operating
 * company; names and ticker patterns are never consulted.
 */
export async function insertSecurityRightsLink(db: D1Database, input: SecurityRightsLinkWrite): Promise<void> {
  const securityCode = classifyResearchSecurity({ code: input.securityCode, instrumentType: "stock" }).code;
  const relatedSecurityCode = classifyResearchSecurity({ code: input.relatedSecurityCode, instrumentType: "stock" }).code;
  if (securityCode === relatedSecurityCode) throw new Error("security rights link requires two distinct securities");
  const evidence = validateSecurityRightsEvidence(input);
  const relatedSharesPerSecurity = finitePositiveOrNull(input.relatedSharesPerSecurity);
  if (input.relationshipKind === "adr_underlying_security" && !relatedSharesPerSecurity) {
    throw new Error("adr_underlying_security requires relatedSharesPerSecurity");
  }
  if (input.relationshipKind !== "adr_underlying_security" && relatedSharesPerSecurity) {
    throw new Error("relatedSharesPerSecurity is only valid for adr_underlying_security");
  }
  if (input.relationshipStatus === "confirmed") {
    const commonCompany = await db.prepare(`select source.company_id as companyId
      from research_company_security_relationships source
      join research_company_security_relationships related on related.company_id=source.company_id
      where source.security_code=? and related.security_code=?
        and source.relationship_status='confirmed' and related.relationship_status='confirmed'
      limit 1`).bind(securityCode, relatedSecurityCode).first<{ companyId: string }>();
    if (!commonCompany?.companyId) {
      throw new Error("confirmed security rights link requires both securities to have the same confirmed operating-company mapping");
    }
  }
  const now = input.now ?? Date.now();
  await db.prepare(`insert into research_security_rights_links (
      rights_link_id, security_code, related_security_code, relationship_kind, relationship_status,
      related_shares_per_security, conversion_availability, relationship_note, effective_from, effective_to,
      evidence_kind, source_url, source_title, source_note, observed_at, metadata_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(required(input.rightsLinkId, "rightsLinkId"), securityCode, relatedSecurityCode, input.relationshipKind,
      input.relationshipStatus, relatedSharesPerSecurity, input.conversionAvailability,
      required(input.relationshipNote, "relationshipNote"), nullable(input.effectiveFrom), nullable(input.effectiveTo),
      evidence.evidenceKind, evidence.sourceUrl, evidence.sourceTitle, evidence.sourceNote,
      requiredTimestamp(input.observedAt, "observedAt"), JSON.stringify(input.metadata ?? {}), now).run();
}

export async function loadResearchIdentityFinancials(
  db: D1Database,
  security: SecurityRecord,
) {
  const classified = classifyResearchSecurity({
    code: security.code,
    name: security.name,
    instrumentType: security.type,
  });
  const [storedSecurity, relationships, identifiers, financialRows, rightsProfiles, rightsLinks] = await Promise.all([
    db.prepare(`select security_code as securityCode, company_id as companyId, venue,
        trading_currency as tradingCurrency, share_class as shareClass, depositary_ratio as depositaryRatio,
        mapping_status as mappingStatus, mapping_basis as mappingBasis, metadata_json as metadataJson,
        created_at as createdAt, updated_at as updatedAt
      from research_listed_securities where security_code=?`).bind(classified.code).first<Record<string, unknown>>(),
    db.prepare(`select r.relationship_id as relationshipId, r.company_id as companyId,
        r.relationship_type as relationshipType, r.relationship_status as relationshipStatus,
        r.source_url as sourceUrl, r.source_note as sourceNote, r.effective_from as effectiveFrom,
        r.effective_to as effectiveTo, r.metadata_json as metadataJson, r.updated_at as updatedAt,
        c.canonical_name as canonicalName, c.reporting_currency as reportingCurrency,
        c.fiscal_year_end as fiscalYearEnd, c.identity_status as identityStatus,
        c.metadata_json as companyMetadataJson
      from research_company_security_relationships r
      join research_operating_companies c on c.company_id=r.company_id
      where r.security_code=? order by
        case r.relationship_status when 'confirmed' then 1 when 'provisional' then 2 when 'needs_review' then 3 else 4 end,
        r.updated_at desc`).bind(classified.code).all<Record<string, unknown>>(),
    db.prepare(`select identifier_id as identifierId, owner_type as ownerType, company_id as companyId,
        security_code as securityCode, provider, identifier_kind as identifierKind,
        identifier_value as identifierValue, identifier_status as identifierStatus,
        source_url as sourceUrl, source_note as sourceNote, observed_at as observedAt,
        metadata_json as metadataJson, updated_at as updatedAt
      from research_provider_identifiers where security_code=? or company_id=(
        select company_id from research_listed_securities where security_code=?
      ) order by provider, identifier_kind, observed_at desc`).bind(classified.code, classified.code).all<Record<string, unknown>>(),
    db.prepare(`select observation_id as observationId, statement_type as statementType, provider,
        source_role as sourceRole, availability_status as status, as_of as asOf,
        latest_period as latestPeriod, reporting_currency as reportingCurrency,
        accounting_basis as accountingBasis, source_url as sourceUrl,
        blocking_reason as blockingReason, details_json as detailsJson
      from research_financial_availability_observations where security_code=?
      order by as_of desc`).bind(classified.code).all<Record<string, unknown>>(),
    db.prepare(`select rights_profile_id as rightsProfileId, security_code as securityCode, rights_status as rightsStatus,
        holder_structure as holderStructure, legal_issuer_name as legalIssuerName, voting_rights_note as votingRightsNote,
        economic_rights_note as economicRightsNote, transferability_note as transferabilityNote,
        structural_risk_note as structuralRiskNote, depositary_name as depositaryName, depositary_fee_note as depositaryFeeNote,
        effective_from as effectiveFrom, effective_to as effectiveTo, evidence_kind as evidenceKind, source_url as sourceUrl,
        source_title as sourceTitle, source_note as sourceNote, observed_at as observedAt, metadata_json as metadataJson
      from research_security_rights_profiles where security_code=? order by observed_at desc`).bind(classified.code).all<Record<string, unknown>>(),
    db.prepare(`select rights_link_id as rightsLinkId, security_code as securityCode, related_security_code as relatedSecurityCode,
        relationship_kind as relationshipKind, relationship_status as relationshipStatus,
        related_shares_per_security as relatedSharesPerSecurity, conversion_availability as conversionAvailability,
        relationship_note as relationshipNote, effective_from as effectiveFrom, effective_to as effectiveTo,
        evidence_kind as evidenceKind, source_url as sourceUrl, source_title as sourceTitle, source_note as sourceNote,
        observed_at as observedAt, metadata_json as metadataJson
      from research_security_rights_links where security_code=? or related_security_code=? order by observed_at desc`).bind(classified.code, classified.code).all<Record<string, unknown>>(),
  ]);
  const relationshipRows = relationships.results.map(mapRelationship);
  const primaryRelationship = relationshipRows.find((item) => item.relationshipStatus === "confirmed")
    ?? relationshipRows.find((item) => item.relationshipStatus === "provisional")
    ?? null;
  const legacyCompany = !primaryRelationship && storedSecurity?.companyId
    ? await loadLegacyCompany(db, String(storedSecurity.companyId))
    : null;
  const operatingCompany = primaryRelationship?.operatingCompany ?? legacyCompany;
  const storedMetadata = parseObject(storedSecurity?.metadataJson);
  const persistedInstrumentKind = storedMetadata.instrumentKind === "adr" || storedMetadata.instrumentKind === "equity"
    ? storedMetadata.instrumentKind : null;
  const instrumentKind = resolveResearchInstrumentKind(classified.instrumentKind, persistedInstrumentKind);
  const financials = buildFinancialCoverage(classified.market, financialRows.results.map(mapFinancialObservation));
  const gaps = [
    ...(!storedSecurity ? ["该证券尚未写入研究身份账本。"] : []),
    ...(!operatingCompany ? ["该证券尚无已确认或待确认的经营公司关系。"] : []),
    ...(classified.eligibility === "needs_review" ? ["证券来源尚未提供已核验的权益工具类型。"] : []),
    ...financials.gaps,
  ];
  return {
    listedSecurity: {
      code: classified.code,
      name: security.name,
      market: classified.market,
      instrumentKind,
      eligibility: classified.eligibility === "needs_review" && persistedInstrumentKind ? "eligible" : classified.eligibility,
      venue: storedSecurity?.venue ?? security.market,
      tradingCurrency: storedSecurity?.tradingCurrency ?? security.currency ?? null,
      // The security-specific currency remains null until its identity record
      // is sourced.  The exchange-market policy is nevertheless deterministic
      // and must be visible to readers instead of presenting CNY/HKD/USD as an
      // unexplained missing value.
      expectedTradingCurrency: financials.policy.expectedTradingCurrency,
      shareClass: storedSecurity?.shareClass ?? null,
      depositaryRatio: numberOrNull(storedSecurity?.depositaryRatio),
      mappingStatus: storedSecurity?.mappingStatus ?? "unresolved",
      mappingBasis: storedSecurity?.mappingBasis ?? null,
      persisted: Boolean(storedSecurity),
      updatedAt: numberOrNull(storedSecurity?.updatedAt),
      metadata: storedMetadata,
    },
    operatingCompany,
    relationships: relationshipRows,
    providerIdentifiers: identifiers.results.map((row) => ({ ...row, metadata: parseObject(row.metadataJson) })),
    rightsProfiles: rightsProfiles.results.map((row) => ({ ...row, metadata: parseObject(row.metadataJson) })),
    rightsLinks: rightsLinks.results.map((row) => ({
      ...normalizeSecurityRightsLinkForSelectedSecurity(row, classified.code),
      metadata: parseObject(row.metadataJson),
    })),
    financials,
    gaps,
  };
}

/** Present a directional stored link from either selected security without
 * making the counterparty appear to be a self-link in the research page. */
export function normalizeSecurityRightsLinkForSelectedSecurity(row: Record<string, unknown>, selectedSecurityCode: string) {
  const fromSelectedSecurity = row.securityCode === selectedSecurityCode;
  return {
    ...row,
    securityCode: selectedSecurityCode,
    relatedSecurityCode: fromSelectedSecurity ? row.relatedSecurityCode : row.securityCode,
    relationshipDirection: fromSelectedSecurity ? "from_selected_security" : "to_selected_security",
  };
}

function mapRelationship(row: Record<string, unknown>) {
  return {
    relationshipId: row.relationshipId,
    companyId: row.companyId,
    relationshipType: row.relationshipType,
    relationshipStatus: row.relationshipStatus,
    sourceUrl: row.sourceUrl,
    sourceNote: row.sourceNote,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    metadata: parseObject(row.metadataJson),
    updatedAt: row.updatedAt,
    operatingCompany: {
      companyId: row.companyId,
      canonicalName: row.canonicalName,
      reportingCurrency: row.reportingCurrency,
      fiscalYearEnd: row.fiscalYearEnd,
      identityStatus: row.identityStatus,
      metadata: parseObject(row.companyMetadataJson),
    },
  };
}

async function loadLegacyCompany(db: D1Database, companyId: string) {
  const row = await db.prepare(`select company_id as companyId, canonical_name as canonicalName,
      reporting_currency as reportingCurrency, fiscal_year_end as fiscalYearEnd,
      identity_status as identityStatus, metadata_json as metadataJson
    from research_operating_companies where company_id=?`).bind(companyId).first<Record<string, unknown>>();
  return row ? { ...row, metadata: parseObject(row.metadataJson) } : null;
}

function mapFinancialObservation(row: Record<string, unknown>): FinancialAvailabilityObservation {
  return {
    observationId: String(row.observationId),
    statementType: row.statementType as FinancialStatementType,
    provider: String(row.provider),
    sourceRole: row.sourceRole as FinancialSourceRole,
    status: row.status as FinancialAvailabilityStatus,
    asOf: Number(row.asOf),
    latestPeriod: nullable(row.latestPeriod),
    reportingCurrency: nullable(row.reportingCurrency),
    accountingBasis: nullable(row.accountingBasis),
    sourceUrl: nullable(row.sourceUrl),
    blockingReason: nullable(row.blockingReason),
    details: parseObject(row.detailsJson),
  };
}

function required(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function nullable(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function finitePositiveOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("depositaryRatio must be a positive number");
  return parsed;
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return value !== null && value !== undefined && Number.isFinite(parsed) ? parsed : null;
}

function requiredTimestamp(value: unknown, label: string): number {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error(`${label} must be a positive timestamp`);
  return timestamp;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
