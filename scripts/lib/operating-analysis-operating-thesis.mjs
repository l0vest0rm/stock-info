import { projectResearchArtifact } from "./research-artifact-projection.mjs";

export const OPERATING_THESIS_SCHEMA_VERSION = "operating-thesis.v1";
export const OPERATING_THESIS_STAGE_KEY = "operating_thesis";

const domainFields = Object.freeze({
  company_facts: ["companyScope", "formalDisclosureFacts", "managementStatements", "reportingAndAccountingNotes", "governanceAndCapitalAllocationFacts", "financialSnapshotRef", "unknowns", "analysisGaps", "sourceIds", "claimIds", "evidenceIds", "usedUpstreamArtifactIds"],
  industry_structure: ["industryBoundary", "valueChain", "profitPool", "marketStructure", "thirdPartyForecasts", "supportsCompanyClaims", "contradictsCompanyClaims", "unknowns", "analysisGaps", "sourceIds", "claimIds", "evidenceIds", "usedUpstreamArtifactIds"],
  supply_demand_cycle: ["demand", "supply", "inventory", "price", "cost", "capital", "cyclePosition", "leadingIndicators", "pressureInputs", "thirdPartyForecasts", "supportsCompanyClaims", "contradictsCompanyClaims", "unknowns", "analysisGaps", "sourceIds", "claimIds", "evidenceIds", "usedUpstreamArtifactIds"],
  competition_peers: ["relevantCompetitiveMarket", "peerSet", "competitivePosition", "barriersAndSubstitutes", "thirdPartyRankings", "supportsCompanyClaims", "contradictsCompanyClaims", "unknowns", "analysisGaps", "sourceIds", "claimIds", "evidenceIds", "usedUpstreamArtifactIds"],
  company_operating_drivers: ["drivers", "orders", "capacity", "priceVolumeMix", "costs", "productsAndRAndD", "catalysts", "counterEvidence", "unknowns", "analysisGaps", "sourceIds", "claimIds", "evidenceIds", "usedUpstreamArtifactIds"],
});

const causalLinkKeys = new Set(["judgmentId", "claimIds", "sourceIds", "supportingEvidenceIds", "counterEvidenceIds", "variablePath", "from", "to", "mechanism", "direction", "confidence", "alternativeExplanations", "invalidationConditions"]);

/**
 * Build the compact S8 input. Every S1-S5 artifact is projected explicitly;
 * no domain Markdown or unlisted field can enter the thesis prompt.
 */
export function buildOperatingThesisInput({ context, artifactsByKey = {}, scopeEnvelopeAvailable = true } = {}) {
  const contextValue = object(context);
  const domains = {};
  const missing = [];
  for (const [stageKey, fields] of Object.entries(domainFields)) {
    const artifact = artifactsByKey[stageKey];
    if (!artifact) {
      missing.push(stageKey);
      continue;
    }
    const projection = projectResearchArtifact({ stageKey, artifact, fields });
    domains[stageKey] = projection;
  }
  const financialSnapshot = object(contextValue.financialSnapshot);
  const financialTrend = Array.isArray(financialSnapshot.deterministicMetrics)
    ? financialSnapshot.deterministicMetrics
    : Array.isArray(financialSnapshot.operatingTrend) ? financialSnapshot.operatingTrend : [];
  const analysisGaps = [...new Set([
    ...(Array.isArray(contextValue.analysisGaps) ? contextValue.analysisGaps : []),
    ...Object.values(domains).flatMap((projection) => projection.analysisGaps || []),
    ...missing.map((stageKey) => ({ gapId: `analysis-gap:missing-${stageKey}`, code: "upstream_artifact_missing", field: stageKey, blocking: true })),
  ].map((gap) => JSON.stringify(gap)))].map((value) => JSON.parse(value));
  const manifest = collectManifest(domains);
  return {
    stage: { key: OPERATING_THESIS_STAGE_KEY, schemaVersion: OPERATING_THESIS_SCHEMA_VERSION, scopeEnvelopeAvailable },
    context: {
      contextVersion: contextValue.contextVersion || null,
      asOf: contextValue.asOf || null,
      company: contextValue.company || null,
      security: contextValue.security || null,
      scopeEnvelope: contextValue.scopeEnvelope ?? null,
      inputFingerprint: contextValue.inputFingerprint || null,
    },
    financialTrend,
    domains,
    manifest,
    analysisGaps,
    status: missing.length ? "blocked" : analysisGaps.some((gap) => gap.blocking) ? "partial" : "ready",
  };
}

/** Validate an S8 model result and reject IDs that were not in S1-S5/S0. */
export function validateOperatingThesisOutput(output, { allowedIds = {} } = {}) {
  const value = object(output);
  const status = text(value.status);
  if (!["complete", "partial", "blocked", "not_applicable"].includes(status)) throw new Error("operating thesis status is invalid");
  if (!Array.isArray(value.causalChain)) throw new Error("operating thesis causalChain must be an array");
  const seenJudgments = new Set();
  for (const [index, link] of value.causalChain.entries()) {
    const row = object(link);
    const judgmentId = namedId(row.judgmentId, `causalChain[${index}].judgmentId`);
    if (seenJudgments.has(judgmentId)) throw new Error(`operating thesis duplicate judgmentId: ${judgmentId}`);
    seenJudgments.add(judgmentId);
    if (!text(row.variablePath) || !text(row.from) || !text(row.to) || !text(row.mechanism)) throw new Error(`operating thesis causalChain[${index}] lacks a causal field`);
    ids(row.claimIds, `causalChain[${index}].claimIds`);
    ids(row.sourceIds, `causalChain[${index}].sourceIds`);
    ids(row.supportingEvidenceIds, `causalChain[${index}].supportingEvidenceIds`);
    ids(row.counterEvidenceIds, `causalChain[${index}].counterEvidenceIds`);
    const unknown = Object.keys(row).filter((key) => !causalLinkKeys.has(key));
    if (unknown.length) throw new Error(`operating thesis causalChain[${index}] has undeclared fields: ${unknown.join(", ")}`);
  }
  if (status === "complete" && value.causalChain.length === 0) throw new Error("complete operating thesis requires causalChain");
  for (const key of ["sourceIds", "claimIds", "evidenceIds", "unknownIds", "usedUpstreamArtifactIds"]) ids(value[key], `output.${key}`);
  assertNoValuationFields(value, "output");
  assertAllowedIds(value, allowedIds);
  return value;
}

/** Small downstream projection consumed by S9; it contains no domain body. */
export function projectOperatingThesisForDownstream(output) {
  const value = validateOperatingThesisOutput(output);
  return {
    schemaVersion: OPERATING_THESIS_SCHEMA_VERSION,
    status: value.status,
    causalChain: value.causalChain,
    judgmentIds: value.causalChain.map((link) => link.judgmentId),
    claimIds: ids(value.claimIds, "output.claimIds"),
    evidenceIds: ids(value.evidenceIds, "output.evidenceIds"),
    sourceIds: ids(value.sourceIds, "output.sourceIds"),
    unknownIds: ids(value.unknownIds, "output.unknownIds"),
    analysisGaps: Array.isArray(value.analysisGaps) ? value.analysisGaps : [],
  };
}

/** Map a visible S8 evidence gap back to the smallest fact-domain rerun set. */
export function deriveOperatingThesisRequeueTargets(analysisGaps = []) {
  const targets = new Set();
  for (const gap of Array.isArray(analysisGaps) ? analysisGaps : []) {
    const code = `${text(gap?.code)} ${text(gap?.field)}`.toLowerCase();
    if (/scope|company|disclosure|management|accounting|governance/.test(code)) targets.add("company_facts");
    if (/industry|profit|value.?chain|market.?structure/.test(code)) targets.add("industry_structure");
    if (/demand|supply|cycle|inventory|price|cost|capital|pressure|indicator/.test(code)) targets.add("supply_demand_cycle");
    if (/peer|comparab|competition|substitute|barrier/.test(code)) targets.add("competition_peers");
    if (/driver|order|capacity|product|r.?and.?d|catalyst|volume|mix/.test(code)) targets.add("company_operating_drivers");
  }
  // Keep the configured fact-domain order so the rerun set is deterministic
  // without letting lexical ordering split related competition/operations
  // stages (the registry executes competition before operating drivers).
  const order = ["company_facts", "industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers"];
  return order.filter((stageKey) => targets.has(stageKey));
}

function collectManifest(domains) {
  const result = { upstreamArtifactIds: new Set(), sourceIds: new Set(), claimIds: new Set(), evidenceIds: new Set(), unknownIds: new Set() };
  for (const projection of Object.values(domains)) {
    for (const key of Object.keys(result)) for (const id of projection[key] || []) result[key].add(id);
    for (const id of projection.sourceArtifactIds || []) result.upstreamArtifactIds.add(id);
  }
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, [...value].sort()]));
}

function assertAllowedIds(value, allowedIds) {
  const allowed = Object.fromEntries(Object.entries(allowedIds || {}).map(([key, list]) => [key, new Set(Array.isArray(list) ? list : [])]));
  for (const [key, set] of Object.entries(allowed)) {
    if (!set.size) continue;
    for (const id of collectIdsByKey(value, key)) if (!set.has(id)) throw new Error(`operating thesis ${key} is not allowed: ${id}`);
  }
}

function collectIdsByKey(value, key, result = []) {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) { value.forEach((item) => collectIdsByKey(item, key, result)); return result; }
  for (const [field, item] of Object.entries(value)) {
    if (field === key && Array.isArray(item)) result.push(...item);
    else if (field === key && typeof item === "string") result.push(item);
    else collectIdsByKey(item, key, result);
  }
  return result;
}

function assertNoValuationFields(value, path) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach((item, index) => assertNoValuationFields(item, `${path}[${index}]`)); return; }
  for (const [key, item] of Object.entries(value)) {
    if (["enterpriseValue", "equityValue", "valuePerShare", "targetPrice", "terminalValue", "calculationResult"].includes(key)) throw new Error(`${path}.${key} is valuation-owned and cannot be supplied by S8`);
    if (item && typeof item === "object") assertNoValuationFields(item, `${path}.${key}`);
  }
}

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function namedId(value, path) { const id = text(value); if (!id || /^\d+$/.test(id) || /\s/.test(id)) throw new Error(`${path} must be a named ID`); return id; }
function ids(value, path) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array of named IDs`);
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    const id = namedId(item, `${path}[${index}]`);
    if (seen.has(id)) throw new Error(`${path} contains duplicate ID: ${id}`);
    seen.add(id);
  }
  return [...seen];
}
