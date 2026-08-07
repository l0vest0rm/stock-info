import type { Bindings, SecurityRecord } from "../../../types";
import { classifyResearchSecurity } from "../domain/research-identity";
import { loadResearchFinancialFactSet } from "./research-financials";
import {
  putFinancialAvailabilityObservation,
  insertSecurityRightsProfile,
  upsertCompanySecurityRelationship,
  upsertListedSecurity,
  upsertOperatingCompany,
  upsertProviderIdentifier,
} from "./research-identity";
import { refreshResearchStatutoryDisclosureIndex } from "./statutory-disclosure-index";
import { loadSecRegistrantXbrl, secRegistrantDocuments } from "../adapters/sec-xbrl";
import { externalHttpOptions } from "../../../shared/http";

/**
 * Establishes the minimum issuer domain needed by automatic research jobs.
 *
 * A security is never merged with another ticker here.  The relationship is
 * intentionally provisional: the stable issuer key is scoped to this listed
 * security until a statutory document or a dedicated cross-listing matcher
 * supplies evidence for a broader issuer relationship.
 */
export async function bootstrapResearchCompany(
  env: Pick<Bindings, "DB" | "MARKET_DATA_BUCKET" | "HTTP_PROXY_URL" | "HTTP_PROXY_RELAY_URL" | "HTTP_PROXY_DOMAINS" | "HTTP_DOMAIN_CONCURRENCY" | "HTTP_REQUEST_TIMEOUT_MS">,
  security: SecurityRecord,
  now = Date.now(),
) {
  const classified = classifyResearchSecurity({ code: security.code, name: security.name, instrumentType: security.type });
  const companyId = `issuer:${classified.code.toLowerCase()}`;
  const registry = classified.market === "a_share" ? "cninfo" : classified.market === "h_share" ? "hkex" : "sec";
  const sourceUrl = `/api/company/info?code=${encodeURIComponent(classified.code)}`;
  const sourceNote = "系统按当前证券代码和证券主数据自动建立单证券发行人域；不按名称合并其他证券，跨市场关系仍需独立来源证据。";

  await upsertListedSecurity(env.DB, { security });
  await upsertOperatingCompany(env.DB, {
    companyId,
    canonicalName: security.name,
    reportingCurrency: security.currency ?? null,
    identityStatus: "provisional",
    metadata: { bootstrapVersion: "research-company-bootstrap.v1", securityCode: classified.code, automatic: true },
    now,
  });
  await upsertCompanySecurityRelationship(env.DB, {
    relationshipId: `company-security:auto:${classified.code}`,
    companyId,
    securityCode: classified.code,
    relationshipType: "primary_listing",
    relationshipStatus: "provisional",
    sourceUrl,
    sourceNote,
    metadata: { bootstrapVersion: "research-company-bootstrap.v1", registry, automatic: true },
    now,
  });
  await upsertProviderIdentifier(env.DB, {
    identifierId: `provider-identifier:auto:${registry}:${classified.code}`,
    ownerType: "listed_security",
    securityCode: classified.code,
    provider: registry,
    identifierKind: "security_code",
    identifierValue: classified.code,
    identifierStatus: "provisional",
    sourceUrl,
    sourceNote,
    observedAt: now,
    metadata: { bootstrapVersion: "research-company-bootstrap.v1", automatic: true },
    now,
  });

  const factSet = await loadResearchFinancialFactSet(env, classified.code);
  const primaryProvider = classified.market === "us_share" ? "yahoo" : "eastmoney";
  const accountingBasis = classified.market === "us_share" ? "US_GAAP" : classified.market === "h_share" ? "IFRS" : "CAS";
  const latestPeriods: Record<string, string | null> = {};
  const financialWrites = factSet.loaded.map(async ({ statementType, result }) => {
    const latestPeriod = result.rows[0]?.reportDate ?? null;
    latestPeriods[statementType] = latestPeriod;
    const healthy = result.sourceHealth.status !== "failed" && result.rows.length > 0;
    await putFinancialAvailabilityObservation(env.DB, {
      observationId: `${primaryProvider}-bootstrap:${classified.code}:${statementType}:${now}`,
      securityCode: classified.code,
      statementType,
      provider: primaryProvider,
      sourceRole: "primary_structured",
      status: healthy ? "partially_available" : "source_unhealthy",
      asOf: now,
      latestPeriod,
      reportingCurrency: result.reportingCurrencies.length === 1 ? result.reportingCurrencies[0] : null,
      accountingBasis,
      sourceUrl: `/api/finance/${statementType}?code=${encodeURIComponent(classified.code)}&format=read-model`,
      blockingReason: healthy ? "主源结构化报表已自动获取；法定字段核验由后续本地任务追加。" : result.sourceHealth.message || "主源结构化报表未返回可用行。",
      details: { bootstrapVersion: "research-company-bootstrap.v1", sourceHealth: result.sourceHealth, originProviders: result.delivery?.originProviders ?? [], automatic: true },
      now,
    });
  });
  await Promise.all(financialWrites);

  const statutoryDocuments = classified.market === "us_share"
    ? await indexSecResearchDocuments(env, classified.code, now)
    : await refreshResearchStatutoryDisclosureIndex(env.DB, classified.code, classified.market === "a_share" ? { page: 1, pageSize: 30 } : { pageSize: 1000 });
  const rights = await bootstrapPlainEquityRights(env.DB, classified, security, registry, statutoryDocuments.documents, now);

  return {
    version: "research-company-bootstrap.v1",
    code: classified.code,
    companyId,
    identity: { status: "provisional", sourceUrl, sourceNote },
    rights,
    financial: {
      primaryProvider,
      statements: factSet.loaded.map(({ statementType, result }) => ({ statementType, rows: result.rows.length, latestPeriod: latestPeriods[statementType] ?? null, sourceHealth: result.sourceHealth })),
    },
    statutoryDocuments: {
      registry,
      availability: statutoryDocuments.availability,
      indexed: statutoryDocuments.documents.length,
      failure: statutoryDocuments.failure ?? null,
    },
  };
}

async function bootstrapPlainEquityRights(
  db: D1Database,
  classified: ReturnType<typeof classifyResearchSecurity>,
  security: SecurityRecord,
  registry: "cninfo" | "hkex" | "sec",
  documents: Array<{ documentUrl?: string; title?: string }>,
  now: number,
) {
  // An ADS/ADR needs an explicit depositary agreement and ratio; a statutory
  // company filing alone is not enough. Ordinary listed equity can however be
  // recorded provisionally from its own official filing without guessing any
  // cross-security relation.
  if (classified.instrumentKind !== "equity") return { status: "blocked" as const, reason: "depositary_or_cross_security_evidence_required" };
  const document = documents.find((item) => /^https:\/\//i.test(item.documentUrl || ""));
  if (!document?.documentUrl) return { status: "blocked" as const, reason: "official_statutory_document_required" };
  const existing = await db.prepare(`select rights_profile_id as rightsProfileId from research_security_rights_profiles
    where security_code=? and source_url=? order by observed_at desc limit 1`).bind(classified.code, document.documentUrl).first<{ rightsProfileId: string }>();
  if (existing?.rightsProfileId) return { status: "provisional" as const, sourceUrl: document.documentUrl, sourceTitle: document.title || `${registry.toUpperCase()} 法定披露`, existing: true };
  const evidenceKind = registry === "hkex" ? "official_exchange_disclosure" as const : "securities_regulator_filing" as const;
  await insertSecurityRightsProfile(db, {
    rightsProfileId: `security-rights:auto:${classified.code}:${now}`,
    securityCode: classified.code,
    rightsStatus: "provisional",
    holderStructure: "direct_registered_holder",
    legalIssuerName: security.name,
    votingRightsNote: "自动任务仅记录该证券为直接登记普通股候选；表决权差异须由后续法定披露明确支持。",
    economicRightsNote: "自动任务未发现可用于跨证券换算的特别经济权利条款。",
    structuralRiskNote: "该记录不证明与其他 A/H/ADR 证券的同一发行人关系，也不允许跨证券估值复用。",
    evidenceKind,
    sourceUrl: document.documentUrl,
    sourceTitle: document.title || `${registry.toUpperCase()} 法定披露`,
    sourceNote: "工程按当前证券的官方法定披露建立单证券普通股权利的 provisional 记录；不使用名称或代码模式推断跨证券关系。",
    observedAt: now,
    metadata: { bootstrapVersion: "research-company-bootstrap.v2", automatic: true, registry },
    now,
  });
  return { status: "provisional" as const, sourceUrl: document.documentUrl, sourceTitle: document.title || `${registry.toUpperCase()} 法定披露` };
}

async function indexSecResearchDocuments(
  env: Pick<Bindings, "DB" | "HTTP_PROXY_URL" | "HTTP_PROXY_RELAY_URL" | "HTTP_PROXY_DOMAINS" | "HTTP_DOMAIN_CONCURRENCY" | "HTTP_REQUEST_TIMEOUT_MS">,
  securityCode: string,
  indexedAt: number,
) {
  const registrant = await loadSecRegistrantXbrl(env.DB, securityCode, externalHttpOptions(env));
  const documents = secRegistrantDocuments(registrant).slice(0, 40);
  await env.DB.batch(documents.map((document) => env.DB.prepare(`insert or ignore into research_statutory_disclosure_documents (
    registry, security_code, document_id, title, published_at, document_url, document_type, source_locator, indexed_at
  ) values ('sec', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(securityCode, document.documentId, document.title, document.publishedAt, document.documentUrl, document.form, document.sourceLocator, indexedAt)));
  return { availability: documents.length ? "available" as const : "not_found" as const, registry: "sec", documents, failure: null };
}
