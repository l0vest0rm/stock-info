#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  RESEARCH_OPERATING_ANALYSIS_COMPANY_FACTS_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_COMPANY_OPERATING_DRIVERS_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_COMPETITION_PEERS_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_FINANCIAL_QUALITY_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_INDUSTRY_STRUCTURE_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_MARKET_VALUATION_FACTS_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_OPERATING_THESIS_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_SCENARIO_VALUATION_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_SUPPLY_DEMAND_CYCLE_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_INVESTMENT_CONCLUSION_PROMPT,
} from "./generated/prompt-text.mjs";
import { fetchLocalRuntime } from "./lib/local-runtime-request.mjs";
import { createLocalJobProvider, loadLocalJobRuntimeConfig, resolveLocalJobApiKey } from "./lib/local-job-provider-registry.mjs";
import { localRuntimeError, localRuntimeLog } from "./lib/local-runtime-log.mjs";
import { buildOperatingAnalysisFinancialContext, buildOperatingAnalysisMarketSnapshot, financialSnapshotForStage, validateFinancialQualitySnapshot } from "./lib/operating-analysis-financial-snapshot.mjs";
import { buildResearchContext, stableHash } from "./lib/research-context.mjs";
import { buildOperatingThesisInput, validateOperatingThesisOutput } from "./lib/operating-analysis-operating-thesis.mjs";
import { buildScenarioValuationInput, validateScenarioValuationOutput } from "./lib/operating-analysis-scenario-valuation.mjs";
import { buildInvestmentConclusionInput, validateInvestmentConclusionOutput } from "./lib/operating-analysis-investment-conclusion.mjs";
import { calculateDeterministicValuation } from "./lib/operating-analysis-deterministic-valuation.mjs";
import { assembleLowDependencyOperatingAnalysisReport } from "./lib/operating-analysis-report.mjs";
import { getResearchOperatingAnalysisStage, researchOperatingAnalysisDependencies, RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES } from "./lib/research-operating-analysis-stage-registry.mjs";
import { applyManualRoutingConfirmation, evaluateLocalTemplateCandidates, matchLocalIndustryTemplate, normalizeEngineeringBaseline, confirmedRoutingProjection } from "./lib/research-scope-industry-routing.mjs";
import { researchOperatingAnalysisStageWaves, runResearchOperatingAnalysisStageWaves } from "./lib/operating-analysis-stage-plan.mjs";

const baseUrl = String(process.env.OPERATING_ANALYSIS_LOW_DEPENDENCY_RUNNER_BASE_URL || process.env.OPERATING_ANALYSIS_RUNNER_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const runnerInstanceId = `operating-analysis-low-dependency-runner:${randomUUID()}`;
const INSTRUCTIONS = "你是严谨的投资研究员。只使用本阶段允许的证据；不以模型记忆填补缺口；严格按输出格式返回。";

export const LOW_DEPENDENCY_RESEARCH_STAGE_KEYS = Object.freeze([
  "company_facts", "industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers", "financial_quality", "market_valuation_facts",
]);
export const LOW_DEPENDENCY_TARGET_STAGE_KEYS = Object.freeze([
  "engineering_baseline", "local_routing_match", ...LOW_DEPENDENCY_RESEARCH_STAGE_KEYS, "operating_thesis", "scenario_valuation", "deterministic_valuation", "investment_conclusion", "report_assembly",
]);
const LOW_DEPENDENCY_SCOPE_STAGE_KEYS = new Set(["industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers"]);

const promptByStage = Object.freeze({
  company_facts: RESEARCH_OPERATING_ANALYSIS_COMPANY_FACTS_PROMPT,
  industry_structure: RESEARCH_OPERATING_ANALYSIS_INDUSTRY_STRUCTURE_PROMPT,
  supply_demand_cycle: RESEARCH_OPERATING_ANALYSIS_SUPPLY_DEMAND_CYCLE_PROMPT,
  competition_peers: RESEARCH_OPERATING_ANALYSIS_COMPETITION_PEERS_PROMPT,
  company_operating_drivers: RESEARCH_OPERATING_ANALYSIS_COMPANY_OPERATING_DRIVERS_PROMPT,
  financial_quality: RESEARCH_OPERATING_ANALYSIS_FINANCIAL_QUALITY_PROMPT,
  market_valuation_facts: RESEARCH_OPERATING_ANALYSIS_MARKET_VALUATION_FACTS_PROMPT,
  operating_thesis: RESEARCH_OPERATING_ANALYSIS_OPERATING_THESIS_PROMPT,
  scenario_valuation: RESEARCH_OPERATING_ANALYSIS_SCENARIO_VALUATION_PROMPT,
  investment_conclusion: RESEARCH_OPERATING_ANALYSIS_INVESTMENT_CONCLUSION_PROMPT,
});

const terminalStatuses = new Set(["complete", "partial", "blocked", "not_applicable", "failed"]);
const successfulStatuses = new Set(["complete", "not_applicable"]);

export function lowDependencyPromptForStage(stageKey) {
  return promptByStage[stageKey] || null;
}

/**
 * Build the low-dependency stage-start request without serializing a null
 * prompt. Deterministic stages intentionally have no model prompt, and the
 * route treats a present null prompt as invalid input.
 */
export function buildLowDependencyStageStartPayload({ input, prompt: modelPrompt, lineage, reuse = true, runnerInstanceId, attempt } = {}) {
  return {
    input,
    ...(modelPrompt === undefined || modelPrompt === null ? {} : { prompt: modelPrompt }),
    lineage,
    reuse,
    runnerInstanceId,
    attempt,
  };
}

/**
 * Construct a stage input from the internal S0 routing projection and explicit
 * field projections. Raw upstream output is never copied into a downstream
 * prompt.
 */
export function buildLowDependencyStageInput({ context, financialContext, stageKey, artifactsByKey = {}, scopeEnvelopeAvailable = true } = {}) {
  const definition = getResearchOperatingAnalysisStage(stageKey);
  if (!LOW_DEPENDENCY_RESEARCH_STAGE_KEYS.includes(stageKey)) throw new Error(`low-dependency runner has no research-stage input contract for ${stageKey}`);
  const contextProjection = { fields: context };
  const financialSnapshot = financialSnapshotForStage(context?.financialSnapshot || financialContext?.descriptor, financialContext || {}, stageKey);
  const input = {
    context: contextProjection.fields,
    stage: { key: definition.key, label: definition.label, schemaVersion: definition.schemaVersion, outputKind: definition.outputKind, owner: definition.owner },
    financialSnapshot,
    scopeEnvelopeAvailable,
    inputFingerprint: context?.inputFingerprint || null,
  };
  if (stageKey !== "engineering_baseline" && stageKey !== "local_routing_match") {
    const routingArtifact = lowDependencyArtifactByKey(artifactsByKey, "local_routing_match");
    input.routing = confirmedRoutingProjection(routingArtifact);
  }
  if (stageKey === "financial_quality") {
    input.financialQualityGate = validateFinancialQualitySnapshot(financialSnapshot, {
      entityType: financialContext?.entityType || context?.company?.entityType || context?.entityType || "operating",
    });
  }
  if (LOW_DEPENDENCY_SCOPE_STAGE_KEYS.has(stageKey)) {
    const scopeProjection = buildLowDependencyScopeProjection({ context: contextProjection.fields, routingArtifact: lowDependencyArtifactByKey(artifactsByKey, "local_routing_match"), scopeEnvelopeAvailable });
    input.scopeProjection = scopeProjection;
    input.companyScope = scopeProjection.companyScope;
    input.scopeGaps = scopeProjection.analysisGaps;
  }
  return input;
}

/** S0.1: collect only local/API material and normalize the auditable scope. */
export function buildEngineeringBaseline({ context = {}, financialContext = {}, sources = [] } = {}) {
  const source = object(context);
  const scopeEnvelope = object(source.scopeEnvelope);
  const materialFacts = [];
  const sourceRefs = Array.isArray(sources) ? sources.map((item) => normalizeBaselineSource(item)).filter(Boolean) : [];
  const scope = {
    primaryBusiness: text(scopeEnvelope.primaryBusiness || scopeEnvelope.business || "") || null,
    products: stringArray(scopeEnvelope.products),
    downstream: stringArray(scopeEnvelope.customers || scopeEnvelope.downstream),
    industry: text(scopeEnvelope.industry || scopeEnvelope.industryName || "") || null,
    regions: stringArray(scopeEnvelope.regions),
    segments: stringArray(scopeEnvelope.segments),
    basisSourceIds: uniqueStrings(scopeEnvelope.basisSourceIds || source.knownSourceIds),
    collectionStatus: Object.keys(scopeEnvelope).length ? "collected_from_local_inputs" : "not_available",
    confirmation: "engineering_only",
  };
  for (const [field, values] of [["primary_business", scope.primaryBusiness ? [scope.primaryBusiness] : []], ["product_boundary", scope.products], ["downstream", scope.downstream], ["industry", scope.industry ? [scope.industry] : []]]) {
    for (const [index, value] of values.entries()) materialFacts.push({ field, factId: `${field}:${index + 1}`, statement: value, sourceReferences: sourceRefs, sourceIds: sourceRefs.map((item) => item.sourceId) });
  }
  const normalized = normalizeEngineeringBaseline({
    company: source.company,
    security: source.security,
    companyScope: { ...scope, facts: materialFacts },
    materials: sourceRefs,
    sourceIds: source.knownSourceIds || sourceRefs.map((item) => item.sourceId),
    unknowns: Object.keys(scopeEnvelope).length ? [] : [{ unknownId: "engineering:scope", code: "scope_not_available_in_local_inputs", message: "本地工程输入没有可审计的主营、产品、下游或行业字段；需要人工确认。", blocking: true }],
    inputFingerprint: source.inputFingerprint,
  }, { inputFingerprint: source.inputFingerprint });
  return { ...normalized, candidateTemplates: evaluateLocalTemplateCandidates(normalized), financialSnapshot: financialContext?.descriptor || source.financialSnapshot || null, collectionBasis: ["company overview API", "structured financial read models", "registered local source candidates"], externalConfirmation: false };
}

/**
 * Build the small scope projection from the deterministic S0 artifact only.
 * When S0 has a non-blocking scope gap, preserve the gap as an explicit
 * unknown boundary so the model can verify it from original sources instead
 * of inferring a market from the ticker or from an S1 Markdown body.
 */
export function buildLowDependencyScopeProjection({ context = {}, routingArtifact = null, scopeEnvelopeAvailable = true } = {}) {
  const routing = object(routingArtifact?.output);
  if (routing.routingState === "confirmed") {
    return {
      status: "available",
      source: "local_routing_match",
      upstreamArtifactIds: routingArtifact?.artifactId ? [routingArtifact.artifactId] : [],
      sourceIds: Array.isArray(routing.sourceIds) ? routing.sourceIds : [],
      analysisGaps: [],
      companyScope: object(routing.companyScope),
    };
  }
  const source = object(context);
  const scopeEnvelope = object(source.scopeEnvelope);
  const contextGaps = Array.isArray(source.analysisGaps) ? source.analysisGaps.filter((gap) => gap && typeof gap === "object" && (gap.field === "scopeEnvelope" || gap.code === "scope_envelope_unreliable")) : [];
  const upstreamArtifactIds = [];
  const sourceIds = Array.isArray(source.knownSourceIds) ? source.knownSourceIds : [];
  if (scopeEnvelopeAvailable && Object.keys(scopeEnvelope).length > 0) {
    return {
      status: "available",
      source: "engineering_baseline",
      upstreamArtifactIds,
      sourceIds,
      analysisGaps: [],
      companyScope: scopeEnvelope,
    };
  }
  const unknownBoundaries = contextGaps.map((gap) => text(gap.message)).filter(Boolean);
  if (!unknownBoundaries.length) unknownBoundaries.push("S0 未提供可验证的产品、客户、地区、用途或分部范围；本域必须从原始来源核实，无法核实时保留 unknown");
  return {
    status: "unknown",
    source: "engineering_baseline",
    upstreamArtifactIds,
    sourceIds,
    analysisGaps: contextGaps,
    companyScope: {
      products: [],
      customers: [],
      regions: [],
      uses: [],
      segments: [],
      uncertainBoundaries: unknownBoundaries,
      basisSourceIds: [],
      scopeStatus: "unknown",
    },
  };
}

export function buildLowDependencyLineage({ stageKey, artifactsByKey = {}, scopeEnvelopeAvailable = true } = {}) {
  const dependencies = researchOperatingAnalysisDependencies(stageKey, { scopeEnvelopeAvailable });
  const upstream = dependencies.flatMap((key) => artifactsByKey[key] ? [artifactsByKey[key]] : []);
  return lineageFromArtifacts(upstream);
}

export function parseLowDependencyStageOutput(stageKey, value) {
  const definition = getResearchOperatingAnalysisStage(stageKey);
  const textValue = String(value || "").trim();
  if (!textValue) throw new Error(`${stageKey} returned empty output`);
  if (definition.outputKind === "markdown") return textValue;
  const stripped = textValue.replace(/^```json\s*|\s*```$/g, "");
  try {
    const parsed = JSON.parse(stripped);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON output must be an object");
    return parsed;
  } catch (error) {
    throw new Error(`${stageKey} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const validationFailureSensitiveKey = /(?:api[_-]?key|access[_-]?token|authorization|cookie|credential|password|private[_-]?key|secret|token)/i;
const validationFailureSecretPattern = /(?:bearer\s+|sk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|access[_-]?token|password|secret|cookie)\s*[:=]\s*)[^\s,;]+/gi;
const validationFailureMaxStringLength = 4_000;
const validationFailureMaxCollectionItems = 100;
const validationFailureMaxDepth = 8;
const validationFailureMaxBytes = 64_000;

/** Keep failed parsed output useful for diagnosis without persisting credentials or an unbounded payload. */
export function sanitizeValidationFailureOutput(value, depth = 0) {
  if (depth > validationFailureMaxDepth) return "[TRUNCATED_DEPTH]";
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.replace(validationFailureSecretPattern, "[REDACTED_SECRET]").slice(0, validationFailureMaxStringLength);
  if (Array.isArray(value)) return value.slice(0, validationFailureMaxCollectionItems).map((item) => sanitizeValidationFailureOutput(item, depth + 1));
  if (typeof value !== "object") return `[UNSUPPORTED_${typeof value}]`;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, validationFailureMaxCollectionItems)) {
    result[key] = validationFailureSensitiveKey.test(key) ? "[REDACTED_SECRET]" : sanitizeValidationFailureOutput(item, depth + 1);
  }
  return result;
}

/** Metadata stored with a failed stage when parsing succeeded but validation did not. */
export function buildValidationFailureMetadata({ parsedOutput, error } = {}) {
  if (parsedOutput === undefined) return null;
  const sanitized = sanitizeValidationFailureOutput(parsedOutput);
  let serialized;
  try { serialized = JSON.stringify(sanitized); } catch { serialized = null; }
  const parsed = serialized && Buffer.byteLength(serialized, "utf8") > validationFailureMaxBytes
    ? { truncated: true, preview: serialized.slice(0, validationFailureMaxBytes) }
    : sanitized;
  return {
    validationFailure: {
      kind: "schema_validation",
      parsedOutput: parsed,
      error: String(error instanceof Error ? error.message : error || "validation failed").slice(0, 1600),
    },
  };
}

/** Build the terminal failed-stage payload while preserving the validation error and status. */
export function buildFailedStagePersistencePayload({ stage, reason, parsedOutput } = {}) {
  const message = String(reason || "stage failed").slice(0, 1600);
  const output = stage?.outputKind === "markdown"
    ? `# ${stage?.label || stage?.key || "Stage"}\n\n（阶段失败：${message}）`
    : { status: "failed", blockedItems: [{ code: "stage_failed", reason: message }] };
  return {
    output,
    status: "failed",
    errorCode: "low_dependency_stage_failed",
    errorMessage: message,
    metadata: buildValidationFailureMetadata({ parsedOutput, error: message }),
  };
}

export function extractLowDependencyManifestLineage(output, inherited = {}) {
  const ids = {
    upstreamArtifactIds: new Set(inherited.upstreamArtifactIds || []),
    sourceIds: new Set(inherited.sourceIds || []),
    claimIds: new Set(inherited.claimIds || []),
    evidenceIds: new Set(inherited.evidenceIds || []),
    unknownIds: new Set(inherited.unknownIds || []),
  };
  const inheritedOrder = Object.fromEntries(Object.entries(ids).map(([key, value]) => [key, [...value]]));
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, item] of Object.entries(value)) {
      if (["upstreamArtifactIds", "usedUpstreamArtifactIds", "sourceIds", "claimIds", "evidenceIds", "unknownIds"].includes(key) && Array.isArray(item)) {
        const target = key === "usedUpstreamArtifactIds" ? ids.upstreamArtifactIds : ids[key];
        for (const id of item) if (typeof id === "string" && id.trim() && !/^\d+$/.test(id.trim()) && !/\s/.test(id)) target.add(id.trim());
      } else {
        const target = { upstreamArtifactId: "upstreamArtifactIds", usedUpstreamArtifactId: "upstreamArtifactIds", sourceId: "sourceIds", claimId: "claimIds", evidenceId: "evidenceIds", unknownId: "unknownIds" }[key];
        if (target && typeof item === "string" && item.trim() && !/^\d+$/.test(item.trim()) && !/\s/.test(item)) ids[target].add(item.trim());
        else visit(item);
      }
    }
  };
  visit(output);
  return Object.fromEntries(Object.entries(ids).map(([key, value]) => {
    const initial = inheritedOrder[key] || [];
    const additions = [...value].filter((id) => !initial.includes(id)).sort();
    return [key, [...initial, ...additions]];
  }));
}

/** Keep S0 preparation deterministic and source-policy bound. */
export function buildLowDependencyContextInput({ code, overview, income, balance, cashflow, sources = [], scopeEnvelope = null } = {}) {
  const financialContext = buildOperatingAnalysisFinancialContext({ income, balance, cashflow });
  const latest = (income?.rows || []).slice().sort((left, right) => String(right.reportDate).localeCompare(String(left.reportDate)))[0] || {};
  const security = { securityCode: code, listingVenue: code.split(".").at(-1) || null, tradingCurrency: "CNY", shareClass: overview?.shareClass || null, rights: overview?.rights || null };
  const marketSnapshot = buildOperatingAnalysisMarketSnapshot({ overview, security });
  const context = buildResearchContext({
    researchTaskId: `research-operating-analysis-low-dependency:${code}`,
    asOf: new Date().toISOString(),
    company: { name: overview?.name || null, reportingCurrency: "CNY", entityType: overview?.entityType || overview?.instrumentType || null },
    security,
    reportingBoundary: { latestFiledPeriod: latest.reportDate || null, latestAnnualPeriod: null, laterProvisionalUpdates: [] },
    financialSnapshot: financialContext.descriptor,
    marketSnapshot: { ...marketSnapshot, currency: marketSnapshot.tradingCurrency || "CNY", periods: [] },
    sources,
    scopeEnvelope,
  });
  return { context, financialContext: { ...financialContext, entityType: overview?.entityType || overview?.instrumentType || "operating" } };
}

/**
 * The company overview currently exposes only compact market facts while the
 * statement read models carry their provider, freshness and delivery metadata.
 * Register both payload families as source versions before S0; an absent
 * `sourceRegistry` field on the overview must not erase provenance that is
 * present in the actual inputs.
 */
export function buildLowDependencySourceCandidates({ code, overview, income, balance, cashflow, asOf = new Date().toISOString() } = {}) {
  const normalizedCode = text(code).toUpperCase();
  const name = text(overview?.name) || normalizedCode;
  const candidates = [];
  const supplied = Array.isArray(overview?.sourceRegistry?.sources)
    ? overview.sourceRegistry.sources
    : Array.isArray(overview?.sources) ? overview.sources : [];
  candidates.push(...supplied);
  if (normalizedCode && text(overview?.source)) {
    const marketDate = text(overview.marketDate) || text(asOf);
    candidates.push({
      url: `/api/company/overview?code=${encodeURIComponent(normalizedCode)}`,
      title: `${name} 行情快照（${text(overview.source)}）`,
      publishedAt: marketDate,
      subject: `${name} (${normalizedCode})`,
      role: "market_data",
      retrievedAt: isoTimestamp(overview.updatedAt, asOf),
      contentFingerprint: stableHash({ kind: "market_snapshot", code: normalizedCode, overview }),
      availabilityStatus: "available",
      limitations: [],
    });
  }
  for (const [statementType, statement] of [["income", income], ["balance", balance], ["cashflow", cashflow]]) {
    if (!statement || typeof statement !== "object" || Array.isArray(statement)) continue;
    const providers = [...new Set([
      text(statement.source),
      ...(Array.isArray(statement.delivery?.originProviders) ? statement.delivery.originProviders : []).map(text),
      ...(Array.isArray(statement.rows) ? statement.rows.map((row) => text(row?.source)) : []),
      text(statement.sourcePolicy?.primaryProvider),
    ].filter(Boolean))];
    if (!providers.length && !Array.isArray(statement.rows)) continue;
    const providerLabel = providers.join("/") || "structured_financial";
    const period = text(statement.latestReportDate) || text(statement.dataAsOf) || text(asOf);
    candidates.push({
      url: `/api/finance/${statementType}?code=${encodeURIComponent(normalizedCode)}&format=read-model`,
      title: `${providerLabel} ${statementLabel(statementType)}（${period}）`,
      publishedAt: period,
      subject: `${name} (${normalizedCode})`,
      role: "structured_financial",
      retrievedAt: isoTimestamp(statement.delivery?.updatedAt || statement.updatedAt, asOf),
      contentFingerprint: stableHash({ kind: "structured_financial", code: normalizedCode, statementType, dataAsOf: statement.dataAsOf, latestReportDate: statement.latestReportDate, providers, sourcePolicy: statement.sourcePolicy, delivery: statement.delivery, rows: statement.rows }),
      availabilityStatus: financialSourceAvailability(statement),
      limitations: statement.sourcePolicy?.statutoryVerifier ? [`法定核验来源：${text(statement.sourcePolicy.statutoryVerifier)}`] : [],
    });
  }
  return candidates;
}

export function lowDependencyTargetWaves(scopeEnvelopeAvailable = true) {
  return researchOperatingAnalysisStageWaves({ scopeEnvelopeAvailable });
}

/** Return the selected stages plus only their declared dependency descendants. */
export function lowDependencyInvalidationClosure(stageKeys = [], scopeEnvelopeAvailable = true) {
  if (!Array.isArray(stageKeys)) throw new Error("low-dependency rerun stage keys must be an array");
  const invalidated = new Set(stageKeys.map((key) => getResearchOperatingAnalysisStage(key).key));
  let changed = true;
  while (changed) {
    changed = false;
    for (const stage of RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES) {
      if (!invalidated.has(stage.key) && researchOperatingAnalysisDependencies(stage.key, { scopeEnvelopeAvailable }).some((dependency) => invalidated.has(dependency))) {
        invalidated.add(stage.key);
        changed = true;
      }
    }
  }
  return RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.map((stage) => stage.key).filter((key) => invalidated.has(key));
}

export function runLowDependencyStageWaves(options = {}) {
  return runResearchOperatingAnalysisStageWaves(options);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
export function lowDependencyArtifactByKey(artifactsByKey, key) {
  return artifactsByKey instanceof Map ? artifactsByKey.get(key) : object(artifactsByKey)[key];
}

function stageStatus(output, stageKey) {
  const status = text(object(output).status);
  if (!terminalStatuses.has(status)) throw new Error(`${stageKey} returned an invalid terminal status`);
  return status;
}

export function stageArtifact(value, fallback = {}) {
  const source = object(value);
  const stageKey = text(source.stageKey) || text(source.stepKey) || text(fallback.stageKey) || text(fallback.stepKey);
  return { ...fallback, ...source, stageKey, stepKey: text(source.stepKey) || stageKey, output: source.output === undefined ? fallback.output : source.output, status: source.status || fallback.status };
}

function lineageFromArtifacts(artifacts) {
  return {
    upstreamArtifactIds: [...new Set(artifacts.flatMap((artifact) => artifact?.artifactId ? [artifact.artifactId] : []))].sort(),
    sourceIds: [...new Set(artifacts.flatMap((artifact) => artifact?.sourceIds || []))].sort(),
    claimIds: [...new Set(artifacts.flatMap((artifact) => artifact?.claimIds || []))].sort(),
    evidenceIds: [...new Set(artifacts.flatMap((artifact) => artifact?.evidenceIds || []))].sort(),
    unknownIds: [...new Set(artifacts.flatMap((artifact) => artifact?.unknownIds || []))].sort(),
  };
}

function scopeAvailable(context) {
  return Boolean(context?.scopeEnvelope && typeof context.scopeEnvelope === "object" && !Array.isArray(context.scopeEnvelope));
}

function statementLabel(statementType) {
  return { income: "利润表", balance: "资产负债表", cashflow: "现金流量表" }[statementType] || statementType;
}

function financialSourceAvailability(statement) {
  const sourceStatus = text(statement?.sourceHealth?.status).toLowerCase();
  const freshness = text(statement?.delivery?.freshness).toLowerCase();
  if (sourceStatus === "conflict") return "conflict";
  if (sourceStatus === "stale" || freshness === "stale") return "stale";
  if (sourceStatus && !["healthy", "ok", "available"].includes(sourceStatus)) return "unavailable";
  return Array.isArray(statement?.rows) && statement.rows.length ? "available" : "unavailable";
}

function normalizeBaselineSource(value) {
  const source = object(value);
  const sourceId = text(source.sourceId || source.id);
  if (!sourceId) return null;
  return {
    sourceId,
    role: text(source.role) || "company_material",
    title: text(source.title) || null,
    url: text(source.url) || null,
    publishedAt: text(source.publishedAt) || null,
    contentFingerprint: text(source.contentFingerprint) || null,
  };
}

function stringArray(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : text(value) ? [text(value)] : [];
}

function uniqueStrings(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(text).filter((item) => item && !/\s/.test(item)))].sort();
}

function isoTimestamp(value, fallback) {
  const numeric = Number(value);
  const candidate = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(text(value));
  if (!Number.isNaN(candidate.getTime())) return candidate.toISOString();
  const fallbackDate = new Date(text(fallback));
  return Number.isNaN(fallbackDate.getTime()) ? new Date().toISOString() : fallbackDate.toISOString();
}

function effectiveContext(baseInput, artifactsByKey) {
  return object(baseInput.context);
}

function prompt(template, input) {
  return template.replace("{{INPUT_DATA}}", JSON.stringify(input, null, 2));
}

async function request(path, init = {}) {
  const response = await fetchLocalRuntime(`${baseUrl}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== 200) throw new Error(body?.msg || `low-dependency runner endpoint failed: ${response.status}`);
  return body.data;
}

function post(path, body) {
  return request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function loadConfig() {
  const runtime = await loadLocalJobRuntimeConfig();
  const analysisConfig = JSON.parse(await readFile(new URL("../config/research-operating-analysis.json", import.meta.url), "utf8"));
  const handler = runtime?.handlers?.researchOperatingAnalysis || {};
  return {
    model: text(analysisConfig.model) || "gpt-5.6-luna",
    jobTimeoutMs: positiveInteger(analysisConfig.jobTimeoutMs, 900_000),
    webSearchJobTimeoutMs: positiveInteger(analysisConfig.webSearchJobTimeoutMs, 1_800_000),
    streamIdleTimeoutMs: positiveInteger(analysisConfig.streamIdleTimeoutMs, 120_000),
    maxOutputTokens: positiveInteger(analysisConfig.maxOutputTokens, 30_000),
    webSearch: { required: analysisConfig?.webSearch?.required === true, searchContextSize: text(analysisConfig?.webSearch?.searchContextSize) || "high" },
    concurrency: positiveInteger(process.env.OPERATING_ANALYSIS_LOW_DEPENDENCY_RUNNER_CONCURRENCY, handler.concurrency || 1),
    pollIntervalMs: positiveInteger(process.env.OPERATING_ANALYSIS_LOW_DEPENDENCY_RUNNER_POLL_INTERVAL_MS, handler.pollIntervalMs || 5_000),
    gracefulShutdownMs: runtime?.lease?.gracefulShutdownMs || 30_000,
  };
}

/** Resources for the universal dispatcher; the DB provider ledger owns the
 * global five-call cap, so one parent pipeline does not add a family cap. */
export async function createLowDependencyRunnerResources() {
  const config = await loadConfig();
  const apiKey = await resolveLocalJobApiKey();
  const dispatcherConfig = { ...config, concurrency: 1 };
  if (!apiKey) return { config: dispatcherConfig, client: null };
  const provider = createLocalJobProvider(apiKey, { streamIdleTimeoutMs: dispatcherConfig.streamIdleTimeoutMs, streamFirstResponseTimeoutMs: dispatcherConfig.jobTimeoutMs });
  return { config: dispatcherConfig, client: createProviderAdapter(provider) };
}

function createProviderAdapter(provider) {
  return {
    async generateText(request) {
      const result = await provider.generate(request);
      return { ...result, provider: request.provider, model: request.model, reasoningText: result.reasoningText || "", cached: false };
    },
    async streamText(request) {
      const result = await provider.stream(request);
      return { ...result, provider: request.provider, model: request.model, reasoningText: result.reasoningText || "", cached: false };
    },
  };
}

async function fetchJobInput(code) {
  const [overview, income, balance, cashflow] = await Promise.all([
    request(`/api/company/overview?code=${encodeURIComponent(code)}`),
    request(`/api/finance/income?code=${encodeURIComponent(code)}&format=read-model`),
    request(`/api/finance/balance?code=${encodeURIComponent(code)}&format=read-model`),
    request(`/api/finance/cashflow?code=${encodeURIComponent(code)}&format=read-model`),
  ]);
  const sourceCandidates = buildLowDependencySourceCandidates({ code, overview, income, balance, cashflow });
  return { ...buildLowDependencyContextInput({ code, overview, income, balance, cashflow, sources: sourceCandidates, scopeEnvelope: overview?.scopeEnvelope || null }), sources: sourceCandidates };
}

async function loadJobState(code) {
  return request(`/api/research/company/${encodeURIComponent(code)}/operating-analysis-low-dependency`);
}

function initialArtifacts(state) {
  const result = new Map();
  for (const stage of Array.isArray(state?.stages) ? state.stages : []) {
    if (stage?.artifactId || stage?.status === "running") {
      const stageKey = text(stage.stageKey) || text(stage.stepKey);
      if (stageKey) result.set(stageKey, { ...stage, stageKey, stepKey: text(stage.stepKey) || stageKey });
    }
  }
  return result;
}

async function callModel({ claim, stage, input, config, client }) {
  const template = lowDependencyPromptForStage(stage.key);
  if (!template) throw new Error(`low-dependency model prompt is unavailable for ${stage.key}`);
  const selectedModel = claim.model || config.model;
  const userPrompt = prompt(template, input);
  const requestInput = {
    provider: "openai",
    requestId: `operating-analysis-low-dependency:${claim.securityCode}:attempt-${claim.attempt}:${stage.key}`,
    model: selectedModel,
    instructions: INSTRUCTIONS,
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    allowReasoning: true,
    reasoningEffort: claim.reasoningEffort,
    maxOutputTokens: config.maxOutputTokens,
    cacheEnabled: false,
    signal: AbortSignal.timeout(stage.webSearch ? config.webSearchJobTimeoutMs : config.jobTimeoutMs),
    ...(stage.webSearch ? { tools: [{ type: "web_search", searchContextSize: config.webSearch.searchContextSize }], toolChoice: "required" } : {}),
  };
  if (stage.webSearch) return client.generateText(requestInput);
  let streamed = "";
  const response = await client.streamText({ ...requestInput, onText: async (delta) => { streamed += delta; } });
  return { ...response, text: text(response?.text) || streamed };
}

function validateModelOutput(stageKey, output, artifactsByKey) {
  const definition = getResearchOperatingAnalysisStage(stageKey);
  if (definition.outputKind === "markdown") {
    const markdown = text(output);
    if (!markdown) throw new Error(`${stageKey} returned empty Markdown output`);
    // Markdown stages intentionally keep the model-visible report body as the
    // artifact payload.  Status and provenance are deterministic runner/API
    // metadata; no JSON envelope or Markdown parser is needed here.
    const upstreamStatuses = definition.dependsOn
      .map((dependency) => text(artifactsByKey?.[dependency]?.status))
      .filter(Boolean);
    const status = upstreamStatuses.includes("partial") ? "partial" : "complete";
    return { output: markdown, status };
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error(`${stageKey} returned a non-object JSON output`);
  const status = stageStatus(output, stageKey);
  if (stageKey === "operating_thesis") return { output: validateOperatingThesisOutput(output), status };
  if (stageKey === "scenario_valuation") return { output: validateScenarioValuationOutput(output), status };
  if (stageKey === "investment_conclusion") {
    const deterministic = lowDependencyArtifactByKey(artifactsByKey, "deterministic_valuation")?.output;
    const calculationIds = Array.isArray(deterministic?.calculationTrace) ? deterministic.calculationTrace.map((trace) => trace?.calculationId).filter(Boolean) : [];
    return { output: validateInvestmentConclusionOutput(output, { calculationIds, deterministicStatus: deterministic?.status || null }), status };
  }
  return { output, status };
}

function buildStageInput(stageKey, baseInput, artifactsByKey, scopeEnvelopeAvailable) {
  const context = effectiveContext(baseInput, artifactsByKey);
  if (LOW_DEPENDENCY_RESEARCH_STAGE_KEYS.includes(stageKey)) return buildLowDependencyStageInput({ context, financialContext: baseInput.financialContext, stageKey, artifactsByKey: Object.fromEntries(artifactsByKey), scopeEnvelopeAvailable });
  if (stageKey === "operating_thesis") return { ...buildOperatingThesisInput({ context, artifactsByKey: Object.fromEntries(artifactsByKey), scopeEnvelopeAvailable }), routing: confirmedRoutingProjection(lowDependencyArtifactByKey(artifactsByKey, "local_routing_match")) };
  if (stageKey === "scenario_valuation") return { ...buildScenarioValuationInput({ context, artifactsByKey: Object.fromEntries(artifactsByKey) }), routing: confirmedRoutingProjection(lowDependencyArtifactByKey(artifactsByKey, "local_routing_match")) };
  if (stageKey === "investment_conclusion") return { ...buildInvestmentConclusionInput({
    context,
    scenarioOutput: lowDependencyArtifactByKey(artifactsByKey, "scenario_valuation")?.output,
    deterministicValuation: lowDependencyArtifactByKey(artifactsByKey, "deterministic_valuation")?.output,
    scenarioArtifact: lowDependencyArtifactByKey(artifactsByKey, "scenario_valuation"),
    thesisArtifact: lowDependencyArtifactByKey(artifactsByKey, "operating_thesis"),
    financialArtifact: lowDependencyArtifactByKey(artifactsByKey, "financial_quality"),
    marketArtifact: lowDependencyArtifactByKey(artifactsByKey, "market_valuation_facts"),
  }), routing: confirmedRoutingProjection(lowDependencyArtifactByKey(artifactsByKey, "local_routing_match")) };
  throw new Error(`no model input builder for ${stageKey}`);
}

async function persistBlockedStage({ claim, stage, value, baseInput, artifactsByKey, scopeEnvelopeAvailable, reason, owner = runnerInstanceId }) {
  const input = stage.key === "report_assembly"
    ? assembleLowDependencyOperatingAnalysisReport({ context: effectiveContext(baseInput, artifactsByKey), stages: [...artifactsByKey.values()], runId: claim.runId })
    : { stage: { key: stage.key, schemaVersion: stage.schemaVersion }, blockedBy: value?.blockedBy || [], reason, inputFingerprint: effectiveContext(baseInput, artifactsByKey).inputFingerprint || null };
  const output = stage.key === "report_assembly"
    ? input.markdown
    : stage.outputKind === "markdown"
      ? `# ${stage.label}\n\n（阶段阻断：${reason}）`
      : { status: "blocked", blockedItems: [{ code: "upstream_stage_blocked", stageKey: stage.key, reason, blockedBy: value?.blockedBy || [] }], analysisGaps: [{ gapId: `analysis-gap:blocked-${stage.key}`, code: "upstream_stage_blocked", blocking: true }] };
  const lineage = buildLowDependencyLineage({ stageKey: stage.key, artifactsByKey: Object.fromEntries(artifactsByKey), scopeEnvelopeAvailable });
  const blockedPrompt = stage.execution === "model" ? { model: claim.model || "gpt-5.6-luna", instructions: INSTRUCTIONS, userPrompt: "上游阶段阻断，本阶段未调用模型。" } : null;
  await post(`/api/research/operating-analysis-low-dependency-jobs/${encodeURIComponent(claim.securityCode)}/stages/${stage.key}/start`, { ...buildLowDependencyStageStartPayload({ input, prompt: blockedPrompt, lineage, reuse: false, runnerInstanceId: owner, attempt: claim.attempt }), taskId: claim.taskId, runId: claim.runId });
  const completed = await post(`/api/research/operating-analysis-low-dependency-jobs/${encodeURIComponent(claim.securityCode)}/stages/${stage.key}/complete`, {
    output, status: "blocked", lineage, metadata: stage.key === "report_assembly" ? { reportManifest: input.manifest, reportStatus: input.status, projectionFingerprint: input.projectionFingerprint } : undefined,
    runnerInstanceId: owner, attempt: claim.attempt, taskId: claim.taskId, runId: claim.runId,
  });
  const normalized = stageArtifact(completed, { stageKey: stage.key, status: "blocked", output, ...lineage });
  artifactsByKey.set(stage.key, normalized);
  return normalized;
}

async function runStage({ claim, stage, baseInput, artifactsByKey, scopeEnvelopeAvailable, config, client, owner = runnerInstanceId }) {
  const existing = artifactsByKey.get(stage.key);
  const forcedStage = Array.isArray(claim.forceStageKeys) ? claim.forceStageKeys.includes(stage.key) : Array.isArray(claim.rerunStageKeys) && claim.rerunStageKeys.includes(stage.key);
  // A child run may see the previous workflow projection. Only an artifact
  // written on this exact run can short-circuit execution; otherwise the
  // stage-start API performs an explicit compatibility reuse/link.
  if (existing && terminalStatuses.has(existing.status) && !forcedStage && existing.runId === claim.runId) return existing;
  const context = effectiveContext(baseInput, artifactsByKey);
  let input;
  let output;
  let status;
  let metadata;
  let started = false;
  let modelPrompt = null;
  if (stage.key === "engineering_baseline") {
    input = { context, financialSnapshot: baseInput.financialContext?.descriptor || context.financialSnapshot || null, sources: baseInput.sources || [] };
    output = buildEngineeringBaseline({ context, financialContext: baseInput.financialContext, sources: baseInput.sources || [] });
    status = output.status === "blocked" ? "blocked" : "complete";
  } else if (stage.key === "local_routing_match") {
    const baseline = lowDependencyArtifactByKey(artifactsByKey, "engineering_baseline")?.output;
    if (!baseline) throw new Error("local routing match requires engineering_baseline output");
    input = { engineeringBaselineArtifactId: lowDependencyArtifactByKey(artifactsByKey, "engineering_baseline")?.artifactId || null, baseline: normalizeEngineeringBaseline(baseline), registryVersion: "research-industry-template-registry.v1" };
    output = matchLocalIndustryTemplate(baseline, { upstreamArtifactIds: lowDependencyArtifactByKey(artifactsByKey, "engineering_baseline")?.artifactId ? [lowDependencyArtifactByKey(artifactsByKey, "engineering_baseline").artifactId] : [] });
    if (baseInput.manualRouting?.selectedTemplateId) output = applyManualRoutingConfirmation(output, baseInput.manualRouting);
    status = output.routingState === "confirmed" ? "complete" : "blocked";
  } else if (stage.key === "deterministic_valuation") {
    input = { context: { contextVersion: context.contextVersion, inputFingerprint: context.inputFingerprint, security: context.security, marketSnapshot: context.marketSnapshot }, routing: confirmedRoutingProjection(lowDependencyArtifactByKey(artifactsByKey, "local_routing_match")), scenario: lowDependencyArtifactByKey(artifactsByKey, "scenario_valuation")?.output || null, inputFingerprint: context.inputFingerprint || null };
    output = calculateDeterministicValuation({ scenarioOutput: lowDependencyArtifactByKey(artifactsByKey, "scenario_valuation")?.output, context });
    status = stageStatus(output, stage.key);
  } else if (stage.key === "report_assembly") {
    const report = assembleLowDependencyOperatingAnalysisReport({ context, stages: [...artifactsByKey.values()], runId: claim.runId });
    // S12's projection includes the current run ID and chapter manifest; use
    // that deterministic fingerprint as its own compatibility boundary so a
    // recovered run rebuilds the final artifact instead of exposing a report
    // whose metadata still names the predecessor run.
    input = { contextVersion: context.contextVersion, inputFingerprint: report.projectionFingerprint, contextInputFingerprint: context.inputFingerprint, runId: claim.runId, manifest: report.manifest, projectionFingerprint: report.projectionFingerprint };
    output = report.markdown;
    status = report.status;
    metadata = { reportManifest: report.manifest, reportStatus: report.status, projectionFingerprint: report.projectionFingerprint, blockers: report.blockers };
  } else {
    input = buildStageInput(stage.key, baseInput, artifactsByKey, scopeEnvelopeAvailable);
    input.inputFingerprint = context.inputFingerprint || null;
    modelPrompt = { model: claim.model || config.model, instructions: INSTRUCTIONS, userPrompt: prompt(lowDependencyPromptForStage(stage.key), input) };
    const initialLineage = buildLowDependencyLineage({ stageKey: stage.key, artifactsByKey: Object.fromEntries(artifactsByKey), scopeEnvelopeAvailable });
    const startedStage = await post(`/api/research/operating-analysis-low-dependency-jobs/${encodeURIComponent(claim.securityCode)}/stages/${stage.key}/start`, { ...buildLowDependencyStageStartPayload({ input, prompt: modelPrompt, lineage: initialLineage, reuse: !forcedStage, runnerInstanceId: owner, attempt: claim.attempt }), taskId: claim.taskId, runId: claim.runId });
    if (startedStage?.artifactId && terminalStatuses.has(startedStage.status)) {
      const normalized = stageArtifact(startedStage, { stageKey: stage.key, status: startedStage.status });
      artifactsByKey.set(stage.key, normalized);
      return normalized;
    }
    started = true;
    const response = await callModel({ claim, stage, input, config, client });
    let parsedOutput;
    try {
      parsedOutput = parseLowDependencyStageOutput(stage.key, response?.text);
      ({ output, status } = validateModelOutput(stage.key, parsedOutput, artifactsByKey));
    } catch (error) {
      // Preserve only successfully parsed structured output for diagnosis. Raw
      // provider text is intentionally not persisted on parse failures.
      if (parsedOutput !== undefined) {
        const validationError = error instanceof Error ? error : new Error(String(error));
        validationError.parsedOutput = parsedOutput;
        throw validationError;
      }
      throw error;
    }
  }
  const inheritedLineage = buildLowDependencyLineage({ stageKey: stage.key, artifactsByKey: Object.fromEntries(artifactsByKey), scopeEnvelopeAvailable });
  if (stage.key === "engineering_baseline") inheritedLineage.sourceIds = Array.isArray(output.sourceIds) ? output.sourceIds : [];
  const lineage = extractLowDependencyManifestLineage(output, inheritedLineage);
  if (!started) {
    const startedStage = await post(`/api/research/operating-analysis-low-dependency-jobs/${encodeURIComponent(claim.securityCode)}/stages/${stage.key}/start`, { ...buildLowDependencyStageStartPayload({ input, prompt: modelPrompt, lineage, reuse: !forcedStage, runnerInstanceId: owner, attempt: claim.attempt }), taskId: claim.taskId, runId: claim.runId });
    if (startedStage?.artifactId && terminalStatuses.has(startedStage.status)) {
      const normalized = stageArtifact(startedStage, { stageKey: stage.key, status: startedStage.status });
      artifactsByKey.set(stage.key, normalized);
      return normalized;
    }
  }
  const completed = await post(`/api/research/operating-analysis-low-dependency-jobs/${encodeURIComponent(claim.securityCode)}/stages/${stage.key}/complete`, { output, status, lineage, metadata, runnerInstanceId: owner, attempt: claim.attempt, taskId: claim.taskId, runId: claim.runId });
  const normalized = stageArtifact(completed, { stageKey: stage.key, status, output, ...lineage });
  // Keep the in-memory dependency map authoritative as soon as a stage settles.
  // The wave callback also records artifacts for persistence/recovery, but a
  // dependent stage in the next wave must never observe a terminal artifact
  // without its normalized output when the API response is compacted.
  artifactsByKey.set(stage.key, normalized);
  return normalized;
}

async function persistFailedStage({ claim, stage, artifactsByKey, baseInput, scopeEnvelopeAvailable, error, owner = runnerInstanceId }) {
  const reason = error instanceof Error ? error.message : String(error);
  try {
    const input = { stage: stage.key, inputFingerprint: effectiveContext(baseInput, artifactsByKey).inputFingerprint || null, error: reason };
    const failure = buildFailedStagePersistencePayload({ stage, reason, parsedOutput: error instanceof Error ? error.parsedOutput : undefined });
    const lineage = buildLowDependencyLineage({ stageKey: stage.key, artifactsByKey: Object.fromEntries(artifactsByKey), scopeEnvelopeAvailable });
    const failurePrompt = stage.execution === "model" ? { model: claim.model || "gpt-5.6-luna", instructions: INSTRUCTIONS, userPrompt: "阶段执行失败，未产生可用终态输出。" } : null;
    await post(`/api/research/operating-analysis-low-dependency-jobs/${encodeURIComponent(claim.securityCode)}/stages/${stage.key}/start`, { ...buildLowDependencyStageStartPayload({ input, prompt: failurePrompt, lineage, reuse: false, runnerInstanceId: owner, attempt: claim.attempt }), taskId: claim.taskId, runId: claim.runId });
    const completed = await post(`/api/research/operating-analysis-low-dependency-jobs/${encodeURIComponent(claim.securityCode)}/stages/${stage.key}/complete`, { output: failure.output, status: failure.status, errorCode: failure.errorCode, errorMessage: failure.errorMessage, lineage, metadata: failure.metadata || undefined, runnerInstanceId: owner, attempt: claim.attempt, taskId: claim.taskId, runId: claim.runId });
    artifactsByKey.set(stage.key, stageArtifact(completed, { stageKey: stage.key, status: failure.status, output: failure.output, ...lineage, lastError: failure.errorMessage, validationFailure: failure.metadata?.validationFailure || null }));
  } catch (persistError) {
    localRuntimeError("research-operating-analysis-low-dependency", "stage_failure_persist_failed", persistError, { stage_key: stage.key, attempt: claim.attempt });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function completeClaimRun(claim, owner, status, metadata = null, error = null) {
  return post(`/api/llm-tasks/${encodeURIComponent(claim.runId)}/complete`, {
    taskId: claim.taskId,
    attempt: claim.attempt,
    runnerInstanceId: owner,
    status: status === "blocked" ? "blocked" : "completed",
    metadata,
    ...(error ? { errorCode: "low_dependency_stage_failed", errorMessage: error instanceof Error ? error.message : String(error) } : {}),
  });
}

async function failClaimRun(claim, owner, error) {
  return post(`/api/llm-tasks/${encodeURIComponent(claim.runId)}/fail`, {
    taskId: claim.taskId,
    attempt: claim.attempt,
    runnerInstanceId: owner,
    errorCode: "low_dependency_stage_failed",
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Execute exactly one materialized S0-S12 child task. Dependencies are
 * enforced by the generic queue; this function never starts sibling stages or
 * creates an in-process resource wave. */
async function runChildStageJob(claim, config, client, interruptedJobs, owner) {
  const stageKey = text(claim.stageKey);
  const stage = getResearchOperatingAnalysisStage(stageKey);
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    void post(`/api/llm-tasks/${encodeURIComponent(claim.runId)}/heartbeat`, { taskId: claim.taskId, attempt: claim.attempt, runnerInstanceId: owner }).catch(() => {});
  }, 10_000);
  let stageStarted = false;
  try {
    const baseInput = await fetchJobInput(claim.securityCode);
    const state = await loadJobState(claim.securityCode);
    baseInput.manualRouting = state?.routing?.manualConfirmation || null;
    const artifactsByKey = initialArtifacts(state);
    const scopeEnvelopeAvailable = scopeAvailable(baseInput.context);
    const childClaim = {
      ...claim,
      // A targeted rerun stores the decision on the child metadata. The
      // generic prepare route forwards it as `forceStage`.
      forceStageKeys: claim.forceStage ? [stage.key] : [],
    };
    const result = await runStage({ claim: childClaim, stage, baseInput, artifactsByKey, scopeEnvelopeAvailable, config, client, owner });
    stageStarted = true;
    const status = text(result?.status) || "complete";
    await completeClaimRun(claim, owner, status, {
      stageKey: stage.key,
      artifactId: result?.artifactId || null,
      artifactStatus: status,
      durationMs: Date.now() - startedAt,
    });
    localRuntimeLog("research-operating-analysis-low-dependency", "child_completed", { task_id: claim.taskId, run_id: claim.runId, stage_key: stage.key, status, duration_ms: Date.now() - startedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/local Node runtime is unavailable|fetch failed|ECONN|UND_ERR/i.test(message)) interruptedJobs.set(claim.securityCode, { message, attempt: claim.attempt, taskId: claim.taskId, runId: claim.runId });
    else {
      const stageFailure = { claim, stage, artifactsByKey: new Map(), baseInput: {}, scopeEnvelopeAvailable: false, error, owner };
      // Best-effort stage artifact persistence keeps failure visible; the
      // fenced generic run remains the source of dependency propagation.
      await persistFailedStage(stageFailure).catch((persistError) => localRuntimeError("research-operating-analysis-low-dependency", "child_failure_persist_failed", persistError, { task_id: claim.taskId, stage_key: stage.key }));
      await failClaimRun(claim, owner, error).catch((failure) => localRuntimeError("research-operating-analysis-low-dependency", "child_failure_terminalize_failed", failure, { task_id: claim.taskId, stage_key: stage.key }));
    }
    localRuntimeLog("research-operating-analysis-low-dependency", stageStarted ? "child_failed" : "child_interrupted", { task_id: claim.taskId, run_id: claim.runId, stage_key: stage.key, duration_ms: Date.now() - startedAt, error: message });
  } finally {
    clearInterval(heartbeat);
  }
}

/** Coordinator task owns no provider slot and waits for child task terminal
 * state. S12's child artifact is the sole report-success gate. */
async function runCoordinatorJob(claim, interruptedJobs, owner) {
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    void post(`/api/llm-tasks/${encodeURIComponent(claim.runId)}/heartbeat`, { taskId: claim.taskId, attempt: claim.attempt, runnerInstanceId: owner }).catch(() => {});
  }, 10_000);
  try {
    while (true) {
      const state = await loadJobState(claim.securityCode);
      const stages = Array.isArray(state?.stages) ? state.stages : [];
      const terminal = stages.length > 0 && stages.every((stage) => ["complete", "not_applicable", "blocked", "failed", "partial"].includes(stage.status));
      if (terminal) {
        const report = stages.find((stage) => stage.stageKey === "report_assembly");
        const failed = stages.some((stage) => ["blocked", "failed", "partial"].includes(stage.status));
        const success = report?.status === "complete" && !failed;
        await completeClaimRun(claim, owner, success ? "completed" : "blocked", {
          coordinator: true,
          reportArtifactId: report?.artifactId || null,
          reportStatus: report?.status || null,
          stageCount: stages.length,
          durationMs: Date.now() - startedAt,
        }, success ? null : new Error("low-dependency child stage/report gate blocked"));
        localRuntimeLog("research-operating-analysis-low-dependency", "coordinator_completed", { task_id: claim.taskId, run_id: claim.runId, status: success ? "completed" : "blocked", duration_ms: Date.now() - startedAt });
        return;
      }
      await sleep(2_000);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/local Node runtime is unavailable|fetch failed|ECONN|UND_ERR/i.test(message)) interruptedJobs.set(claim.securityCode, { message, attempt: claim.attempt, taskId: claim.taskId, runId: claim.runId });
    else await failClaimRun(claim, owner, error).catch((failure) => localRuntimeError("research-operating-analysis-low-dependency", "coordinator_failure_terminalize_failed", failure, { task_id: claim.taskId }));
  } finally {
    clearInterval(heartbeat);
  }
}

export async function runJob(claim, config, client, interruptedJobs = new Map(), owner = claim.runnerInstanceId || runnerInstanceId) {
  if (claim?.stageKey) return runChildStageJob(claim, config, client, interruptedJobs, owner);
  if (claim?.handlerKey === "research_operating_analysis_low_dependency_coordinator" || claim?.coordinator === true || claim?.executionMode === "engineering") return runCoordinatorJob(claim, interruptedJobs, owner);
  const startedAt = Date.now();
  const heartbeat = setInterval(() => { void post(`/api/research/operating-analysis-low-dependency-jobs/${encodeURIComponent(claim.securityCode)}/heartbeat`, { runnerInstanceId: owner, attempt: claim.attempt }).catch(() => {}); }, 10_000);
  let pipelineStarted = false;
  localRuntimeLog("research-operating-analysis-low-dependency", "started", { task_id: claim.taskId, run_id: claim.runId, attempt: claim.attempt, security_code: claim.securityCode });
  try {
    const baseInput = await fetchJobInput(claim.securityCode);
    const state = await loadJobState(claim.securityCode);
    baseInput.manualRouting = state?.routing?.manualConfirmation || null;
    const artifactsByKey = initialArtifacts(state);
    const scopeEnvelopeAvailable = scopeAvailable(baseInput.context);
    const runClaim = { ...claim, forceStageKeys: lowDependencyInvalidationClosure(claim.rerunStageKeys || [], scopeEnvelopeAvailable) };
    pipelineStarted = true;
    const results = await runResearchOperatingAnalysisStageWaves({
      scopeEnvelopeAvailable,
      resourceCap: config.concurrency,
      runStage: (stage) => runStage({ claim: runClaim, stage, baseInput, artifactsByKey, scopeEnvelopeAvailable, config, client, owner }),
      onStageSettled: async (stage, result) => {
        if (result.status === "fulfilled") {
          if (result.value?.artifactId) artifactsByKey.set(stage.key, result.value);
          else if (result.value?.status === "blocked") await persistBlockedStage({ claim, stage, value: result.value, baseInput, artifactsByKey, scopeEnvelopeAvailable, reason: result.value.reason, owner });
        } else await persistFailedStage({ claim, stage, artifactsByKey, baseInput, scopeEnvelopeAvailable, error: result.reason, owner });
      },
    });
    const reportResult = results.find((item) => item.stage.key === "report_assembly")?.output;
    const finalStatus = reportResult?.status || artifactsByKey.get("report_assembly")?.status || "blocked";
    await post(`/api/research/operating-analysis-low-dependency-jobs/${encodeURIComponent(claim.securityCode)}/complete`, { reportStatus: finalStatus, reportArtifactId: artifactsByKey.get("report_assembly")?.artifactId || null, runnerInstanceId: owner, attempt: claim.attempt });
    localRuntimeLog("research-operating-analysis-low-dependency", "completed", { task_id: claim.taskId, run_id: claim.runId, attempt: claim.attempt, security_code: claim.securityCode, status: finalStatus, duration_ms: Date.now() - startedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/local Node runtime is unavailable|fetch failed|ECONN|UND_ERR/i.test(message)) interruptedJobs.set(claim.securityCode, { message, attempt: claim.attempt });
    else await post(`/api/research/operating-analysis-low-dependency-jobs/${encodeURIComponent(claim.securityCode)}/fail`, { error: message, runnerInstanceId: owner, attempt: claim.attempt }).catch((failure) => localRuntimeError("research-operating-analysis-low-dependency", "failure_persist_failed", failure, { task_id: claim.taskId, attempt: claim.attempt }));
    localRuntimeLog("research-operating-analysis-low-dependency", pipelineStarted ? "failed" : "interrupted", { task_id: claim.taskId, run_id: claim.runId, attempt: claim.attempt, security_code: claim.securityCode, duration_ms: Date.now() - startedAt, error: message });
  } finally { clearInterval(heartbeat); }
}

async function recoverInterruptedJobs(interruptedJobs) {
  for (const [securityCode, interrupted] of interruptedJobs) {
    try {
      const result = interrupted.taskId && interrupted.runId
        ? await post(`/api/llm-tasks/${encodeURIComponent(interrupted.runId)}/requeue`, { taskId: interrupted.taskId, error: interrupted.message, runnerInstanceId, attempt: interrupted.attempt })
        : await post(`/api/research/operating-analysis-low-dependency-jobs/${encodeURIComponent(securityCode)}/requeue`, { error: interrupted.message, runnerInstanceId, attempt: interrupted.attempt });
      if (result?.requeued) {
        interruptedJobs.delete(securityCode);
        localRuntimeLog("research-operating-analysis-low-dependency", "requeued", { security_code: securityCode, attempt: interrupted.attempt });
      }
    } catch (error) {
      if (!/lease|owned|not found/i.test(error instanceof Error ? error.message : String(error))) localRuntimeError("research-operating-analysis-low-dependency", "requeue_failed", error, { security_code: securityCode, attempt: interrupted.attempt });
    }
  }
}

export function startResearchOperatingAnalysisLowDependencyRunner() {
  const ready = Promise.all([loadConfig(), resolveLocalJobApiKey()]).then(([config, apiKey]) => {
    if (!apiKey) throw new Error("local low-dependency operating-analysis runner requires OPENAI_API_KEY or ~/.codex/auth.json");
    return { config, client: createProviderAdapter(createLocalJobProvider(apiKey, { streamIdleTimeoutMs: config.streamIdleTimeoutMs, streamFirstResponseTimeoutMs: config.jobTimeoutMs })) };
  });
  let accepting = true;
  let polling = false;
  let requested = false;
  const active = new Set();
  const interruptedJobs = new Map();
  async function heartbeatRunnerLease() {
    try { return (await post("/api/research/operating-analysis-runner-lease/heartbeat", { runnerInstanceId }))?.active === true; }
    catch { return false; }
  }
  async function poll() {
    if (!accepting) return;
    if (polling) { requested = true; return; }
    polling = true;
    try {
      const { config, client } = await ready;
      if (!await heartbeatRunnerLease()) return;
      await recoverInterruptedJobs(interruptedJobs);
      while (accepting && active.size < config.concurrency) {
        const claim = await post("/api/research/operating-analysis-low-dependency-jobs/claim-next", { runnerInstanceId });
        if (!claim?.jobId || !claim?.securityCode) break;
        let work;
        work = runJob(claim, config, client, interruptedJobs).finally(() => { active.delete(work); void poll(); });
        active.add(work);
      }
    } catch (error) { localRuntimeError("research-operating-analysis-low-dependency", "polling_paused", error); }
    finally { polling = false; if (requested && accepting) { requested = false; void poll(); } }
  }
  localRuntimeLog("research-operating-analysis-low-dependency", "polling_started", { runner_instance_id: runnerInstanceId, base_url: baseUrl });
  void poll();
  const timer = setInterval(() => void poll(), positiveInteger(process.env.OPERATING_ANALYSIS_LOW_DEPENDENCY_RUNNER_POLL_INTERVAL_MS, 5_000));
  return {
    async stop(options = {}) {
      accepting = false;
      clearInterval(timer);
      const readyConfig = await ready.then((value) => value.config).catch(() => ({ gracefulShutdownMs: 30_000 }));
      const gracefulTimeoutMs = positiveInteger(options.gracefulTimeoutMs, readyConfig.gracefulShutdownMs);
      await Promise.race([Promise.allSettled([...active]), new Promise((resolve) => setTimeout(resolve, gracefulTimeoutMs))]);
    },
  };
}

// The local worker uses this explicit target-protocol export. The alias keeps
// standalone integrations from accidentally importing the legacy runner file.
export const startResearchOperatingAnalysisRunner = startResearchOperatingAnalysisLowDependencyRunner;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = startResearchOperatingAnalysisLowDependencyRunner();
  const stop = () => { void controller.stop().finally(() => process.exit(0)); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
